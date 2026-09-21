export async function boundedLookup<T>(lookup: () => Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			lookup(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Recovery lookup timed out")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
