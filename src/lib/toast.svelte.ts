export interface Toast {
	id: number;
	message: string;
	kind: 'info' | 'error';
	actionLabel?: string;
	onAction?: () => void | Promise<void>;
	/** Teljes megjelenési idő (ms) – ehhez igazodik a visszaszámláló sáv. */
	duration: number;
	/** Az időzítő áll (érintés, egérmutató vagy fókusz a toaston). */
	paused: boolean;
}

type PauseReason = 'pointer' | 'focus';

interface Timer {
	handle?: ReturnType<typeof setTimeout>;
	remaining: number;
	startedAt: number;
	reasons: Set<PauseReason>;
}

class Toasts {
	items = $state<Toast[]>([]);
	private next = 1;
	private timers = new Map<number, Timer>();

	show(
		message: string,
		opts: {
			kind?: 'info' | 'error';
			actionLabel?: string;
			onAction?: () => void | Promise<void>;
			duration?: number;
		} = {}
	) {
		const id = this.next++;
		const duration = opts.duration ?? (opts.actionLabel ? 7000 : 3500);
		this.items = [
			...this.items,
			{
				id,
				message,
				kind: opts.kind ?? 'info',
				actionLabel: opts.actionLabel,
				onAction: opts.onAction,
				duration,
				paused: false
			}
		];
		this.timers.set(id, { remaining: duration, startedAt: 0, reasons: new Set() });
		this.run(id);
		return id;
	}

	error(message: string) {
		return this.show(message, { kind: 'error', duration: 6000 });
	}

	dismiss(id: number) {
		clearTimeout(this.timers.get(id)?.handle);
		this.timers.delete(id);
		this.items = this.items.filter((t) => t.id !== id);
	}

	/** Amíg rajta van az ujj, az egér vagy a fókusz, a toast nem tűnik el. */
	pause(id: number, reason: PauseReason) {
		const t = this.timers.get(id);
		if (!t) return;
		t.reasons.add(reason);
		if (t.handle === undefined) return;
		clearTimeout(t.handle);
		t.handle = undefined;
		t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
		this.setPaused(id, true);
	}

	resume(id: number, reason: PauseReason) {
		const t = this.timers.get(id);
		if (!t) return;
		t.reasons.delete(reason);
		if (t.reasons.size > 0 || t.handle !== undefined) return;
		this.setPaused(id, false);
		this.run(id);
	}

	private run(id: number) {
		const t = this.timers.get(id);
		if (!t) return;
		t.startedAt = Date.now();
		t.handle = setTimeout(() => this.dismiss(id), t.remaining);
	}

	private setPaused(id: number, paused: boolean) {
		const item = this.items.find((x) => x.id === id);
		if (item) item.paused = paused;
	}
}

export const toasts = new Toasts();
