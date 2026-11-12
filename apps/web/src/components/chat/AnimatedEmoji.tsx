import type { AnimationItem, LottiePlayer } from 'lottie-web';
import { useEffect, useRef, useState } from 'react';
import { animatedHex } from '@/lib/emoji/jumbo';
import { useReducedMotion } from '@/lib/motion';

/**
 * A large emoji that plays its Google Noto Animated Emoji (CC BY 4.0) when it is on screen:
 * the Lottie player (lottie-web light, no `eval`) and the animation file load only then, it
 * plays a couple of loops and stops, pauses off screen, and stays still with reduced motion.
 * Until it plays, and for emojis without an animation, the system emoji is shown.
 */

const LOOPS = 2;

let player: Promise<LottiePlayer> | null = null;
const files = new Map<string, Promise<unknown>>();

function loadPlayer(): Promise<LottiePlayer> {
  player ??= import('lottie-web/build/player/lottie_light').then((m) => m.default);
  return player;
}

function loadFile(hex: string): Promise<unknown> {
  let file = files.get(hex);
  if (!file) {
    file = fetch(`${import.meta.env.BASE_URL}emoji/anim/${hex}.json`).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<unknown>;
    });
    file.catch(() => files.delete(hex));
    files.set(hex, file);
  }
  return file;
}

export function AnimatedEmoji({ emoji, size }: { emoji: string; size: number }) {
  const reduced = useReducedMotion();
  const hex = animatedHex(emoji);
  const box = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!hex || reduced || !el || typeof IntersectionObserver === 'undefined') return;
    let anim: AnimationItem | null = null;
    let loading = false;
    let gone = false;
    let loops = 0;

    const play = () => {
      if (!anim) return;
      loops = 0;
      anim.goToAndPlay(0, true);
    };
    const start = async () => {
      if (anim || loading) return play();
      loading = true;
      try {
        const [lottie, data] = await Promise.all([loadPlayer(), loadFile(hex)]);
        if (gone || !box.current) return;
        anim = lottie.loadAnimation({
          container: box.current,
          renderer: 'svg',
          loop: false,
          autoplay: true,
          animationData: data,
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        });
        anim.addEventListener('complete', () => {
          loops += 1;
          if (loops < LOOPS) anim?.goToAndPlay(0, true);
        });
        anim.addEventListener('DOMLoaded', () => !gone && setReady(true));
      } catch {
        // No file or no player: the system emoji stays.
      } finally {
        loading = false;
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void start();
        else anim?.pause();
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      gone = true;
      io.disconnect();
      anim?.destroy();
      setReady(false);
    };
  }, [hex, reduced]);

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={emoji}
    >
      {ready ? null : (
        <span aria-hidden="true" style={{ fontSize: size * 0.82, lineHeight: 1 }}>
          {emoji}
        </span>
      )}
      <span
        ref={box}
        aria-hidden="true"
        className={ready ? 'absolute inset-0' : 'absolute inset-0 opacity-0'}
      />
    </span>
  );
}

/** An emoji-only message: the emojis large, animated where available. */
export function JumboEmojis({ emojis }: { emojis: string[] }) {
  const size = emojis.length === 1 ? 56 : 44;
  return (
    <div className="flex items-center gap-1 py-0.5" data-jumbo="">
      {emojis.map((e, i) => (
        <AnimatedEmoji key={`${i}-${e}`} emoji={e} size={size} />
      ))}
    </div>
  );
}
