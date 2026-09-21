export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error !== null && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}
