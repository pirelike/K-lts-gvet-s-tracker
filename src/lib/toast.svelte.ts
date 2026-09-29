export interface Toast {
	id: number;
	message: string;
	kind: 'info' | 'error';
	actionLabel?: string;
	onAction?: () => void | Promise<void>;
}

class Toasts {
	items = $state<Toast[]>([]);
	private next = 1;

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
		this.items = [
			...this.items,
			{ id, message, kind: opts.kind ?? 'info', actionLabel: opts.actionLabel, onAction: opts.onAction }
		];
		const duration = opts.duration ?? (opts.actionLabel ? 7000 : 3500);
		setTimeout(() => this.dismiss(id), duration);
		return id;
	}

	error(message: string) {
		return this.show(message, { kind: 'error', duration: 6000 });
	}

	dismiss(id: number) {
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new Toasts();
