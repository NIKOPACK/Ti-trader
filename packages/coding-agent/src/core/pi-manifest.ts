import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type ManifestFlavor = "pi" | "ti";

/** Ti extends the pi package convention with an equivalent `ti` manifest. */
export type TiManifest = PiManifest;

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPiManifest(packageJsonPath: string, flavor: ManifestFlavor = "pi"): TiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) return null;
		// A caller selects its manifest namespace explicitly. The fallback keeps Ti
		// compatible with existing Pi packages without changing Pi precedence.
		const resourceManifest =
			flavor === "ti"
				? isObject(pkg.ti)
					? pkg.ti
					: isObject(pkg.pi)
						? pkg.pi
						: null
				: isObject(pkg.pi)
					? pkg.pi
					: null;
		if (!resourceManifest) return null;

		const manifest: TiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = resourceManifest[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
