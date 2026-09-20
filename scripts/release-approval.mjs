import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

export function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	const keys = Object.keys(value)
		.filter((key) => value[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function approvalPayload(evidence) {
	if (!record(evidence) || !record(evidence.pilotApproval)) return undefined;
	const approval = evidence.pilotApproval;
	return {
		approval: {
			approvedAt: approval.approvedAt,
			confirmEveryOrder: approval.confirmEveryOrder,
			exchange: approval.exchange,
			market: approval.market,
			maxNotional: approval.maxNotional,
			quoteCurrency: approval.quoteCurrency,
			reviewer: approval.reviewer,
			revision: approval.revision,
			scope: approval.scope,
			withdrawalsDisabled: approval.withdrawalsDisabled,
		},
		artifacts: {
			drills: evidence.drills,
			installation: evidence.installation,
			liveCapabilities: evidence.liveCapabilities,
			offline: evidence.offline,
			soak: evidence.soak,
		},
		revision: evidence.revision,
		schemaVersion: evidence.schemaVersion,
		versions: evidence.versions,
	};
}

export function signApproval(payload, privateKeyPem) {
	return sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyApprovalSignature(payload, signatureValue, publicKeyPem) {
	if (payload === undefined || !text(signatureValue) || !text(publicKeyPem)) return false;
	try {
		return verify(
			null,
			Buffer.from(canonicalJson(payload)),
			createPublicKey(publicKeyPem),
			Buffer.from(signatureValue, "base64"),
		);
	} catch {
		return false;
	}
}

export function loadReleaseReviewers(path) {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!record(parsed) || !Array.isArray(parsed.reviewers)) throw new Error("reviewer registry is invalid");
	return parsed.reviewers.filter(
		(entry) =>
			record(entry) &&
			text(entry.id) &&
			text(entry.keyId) &&
			text(entry.publicKeyPem) &&
			(entry.status === "active" || entry.status === "revoked"),
	);
}

export function verifyPilotApproval(evidence, reviewers) {
	if (!Array.isArray(reviewers)) {
		return { ok: false, reason: "pilotApproval: trusted reviewer registry is missing or invalid" };
	}
	const active = reviewers.filter((entry) => record(entry) && entry.status === "active");
	if (active.length === 0) {
		return { ok: false, reason: "pilotApproval: no active trusted reviewer keys are configured" };
	}
	const approval = record(evidence) ? evidence.pilotApproval : undefined;
	const signature = record(approval) ? approval.signature : undefined;
	if (!record(signature) || signature.alg !== "ed25519" || !text(signature.keyId) || !text(signature.value)) {
		return { ok: false, reason: "pilotApproval: Ed25519 signature is required" };
	}
	const reviewer = active.find(
		(entry) => entry.id === approval.reviewer && entry.keyId === signature.keyId && text(entry.publicKeyPem),
	);
	if (!reviewer) {
		return { ok: false, reason: "pilotApproval: reviewer is not a trusted active key" };
	}
	if (!verifyApprovalSignature(approvalPayload(evidence), signature.value, reviewer.publicKeyPem)) {
		return { ok: false, reason: "pilotApproval: signature does not match the canonical candidate and scope" };
	}
	return { ok: true };
}
