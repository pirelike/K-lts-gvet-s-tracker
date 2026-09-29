/**
 * Reaktív „ma": a napi dátum nem csak az oldal betöltésekor számolódik. Frissül, ha az app
 * előtérbe kerül (háttérből visszahozott PWA), ha a lap fókuszt kap, és a következő helyi éjfélkor.
 * Így „soha" automatikus zárolás mellett sem ragad be az előző nap/hónap.
 */
import { msUntilMidnight, monthOf, todayISO } from './dates';

class Clock {
	today = $state(todayISO());
	month = $derived(monthOf(this.today));
	private timer: ReturnType<typeof setTimeout> | undefined;
	private started = false;

	refresh() {
		const now = todayISO();
		if (now !== this.today) this.today = now;
	}

	start() {
		if (this.started || typeof document === 'undefined') return;
		this.started = true;
		const onWake = () => {
			if (!document.hidden) this.refresh();
			this.arm();
		};
		document.addEventListener('visibilitychange', onWake);
		window.addEventListener('focus', onWake);
		window.addEventListener('pageshow', onWake);
		this.arm();
	}

	/** Éjfélkorra időzít egy frissítést (az időzítők háttérben elhalaszthatók, ezért a fenti eseményekre is szükség van). */
	private arm() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.refresh();
			this.arm();
		}, msUntilMidnight() + 500);
	}
}

export const clock = new Clock();
