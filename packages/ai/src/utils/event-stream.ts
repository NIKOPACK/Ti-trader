import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: Error) => void;
	private finalResultSettled = false;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		// A consumer may only iterate the stream and never call result(). Mark the
		// internal promise as observed so natural end-of-stream errors do not become
		// process-level unhandled rejections; result() still returns the rejection.
		void this.finalResultPromise.catch(() => undefined);
	}

	push(event: T): void {
		if (this.done) return;

		let complete: boolean;
		try {
			complete = this.isComplete(event);
		} catch (error) {
			this.done = true;
			this.finalResultSettled = true;
			this.rejectFinalResult(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}

		if (complete) {
			this.done = true;
			try {
				const result = this.extractResult(event);
				this.finalResultSettled = true;
				this.resolveFinalResult(result);
			} catch (error) {
				this.finalResultSettled = true;
				this.rejectFinalResult(error instanceof Error ? error : new Error(String(error)));
				throw error;
			}
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.finalResultSettled = true;
			this.resolveFinalResult(result);
		} else if (!this.finalResultSettled) {
			this.finalResultSettled = true;
			this.rejectFinalResult(new Error("Event stream ended before a final result was received"));
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
