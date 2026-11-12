import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light';
import light from '../../assets/lottie/crewhall-loader.json';
import dark from '../../assets/lottie/crewhall-loader-white.json';
import { h } from './dom';
import { reducedMotion } from './motion';

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * The Crewhall loader (crewhall-brand/lottie): the mark draws itself in, from frame 0, and
 * loops. Inlined in the bundle, no fetch. Light or white by the system theme, following a
 * theme change; a still mark when the OS asks for reduced motion. Sized by CSS (.loader).
 */
export function loader(label: string, size: 'large' | 'small' = 'large'): HTMLElement {
  const box = h('div', { class: `loader ${size}`, role: 'img', 'aria-label': label });
  if (reducedMotion()) {
    box.append(
      h(
        'picture',
        {},
        h('source', {
          srcset: '../assets/crewhall-mark-white.svg',
          media: '(prefers-color-scheme: dark)',
        }),
        h('img', { src: '../assets/crewhall-mark.svg', alt: '' }),
      ),
    );
    return box;
  }

  let anim: AnimationItem | null = null;
  const play = () => {
    anim?.destroy();
    anim = lottie.loadAnimation({
      container: box,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: darkScheme.matches ? dark : light,
    });
  };
  play();
  darkScheme.addEventListener('change', () => {
    if (box.isConnected) play();
  });
  return box;
}
