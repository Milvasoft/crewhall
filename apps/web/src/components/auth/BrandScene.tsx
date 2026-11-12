import { CrewhallMark } from '@crewhall/ui';
import { useId } from 'react';

/**
 * Default login scene (doc 01 · 1.1): circuit traces around an emblem chip with yellow signals.
 * The emblem is the org mark when uploaded, else the Crewhall mark. Always drawn on graphite.
 */

const TRACES: [string, number, number, 'pd' | 'ps'][] = [
  ['M180 300 H44', 36, 300, 'pd'],
  ['M184 268 H128 L98 238 H22', 14, 238, 'ps'],
  ['M184 332 H128 L98 362 H22', 14, 362, 'pd'],
  ['M200 232 H156 L118 194 H66', 58, 194, 'ps'],
  ['M200 368 H156 L118 406 H66', 58, 406, 'pd'],
  ['M420 300 H556', 564, 300, 'ps'],
  ['M416 268 H472 L502 238 H578', 586, 238, 'pd'],
  ['M416 332 H472 L502 362 H578', 586, 362, 'ps'],
  ['M400 232 H444 L482 194 H534', 542, 194, 'pd'],
  ['M400 368 H444 L482 406 H534', 542, 406, 'ps'],
  ['M300 180 V44', 300, 36, 'pd'],
  ['M268 184 V128 L238 98 V22', 238, 14, 'ps'],
  ['M332 184 V128 L362 98 V22', 362, 14, 'pd'],
  ['M300 420 V556', 300, 564, 'ps'],
  ['M268 416 V472 L238 502 V578', 238, 586, 'pd'],
  ['M332 416 V472 L362 502 V578', 362, 586, 'ps'],
];

const SIGNALS: [number, number][] = [
  [96, 300],
  [60, 362],
  [504, 300],
  [300, 96],
  [540, 238],
  [300, 520],
];

export function BrandScene({ markUrl }: { markUrl: string | null }) {
  const id = useId().replace(/:/g, '');
  const yellow = '#FBC419';
  return (
    <svg
      viewBox="0 0 600 600"
      aria-hidden="true"
      className="size-[430px] shrink-0 overflow-visible"
    >
      <defs>
        <radialGradient id={`${id}f`} cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#fff" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}m`}>
          <rect width="600" height="600" fill={`url(#${id}f)`} />
        </mask>
        <radialGradient id={`${id}g`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={yellow} stopOpacity=".22" />
          <stop offset="100%" stopColor={yellow} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="300" cy="300" r="170" fill={`url(#${id}g)`} />
      <g mask={`url(#${id}m)`}>
        <circle cx="300" cy="300" r="286" fill="none" stroke="rgba(255,255,255,.07)" />
        <circle cx="300" cy="300" r="196" fill="none" stroke="rgba(255,255,255,.07)" />
        {TRACES.map(([d, cx, cy, kind]) => (
          <g key={d}>
            <path
              d={d}
              fill="none"
              stroke="rgba(255,255,255,.24)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            {kind === 'pd' ? (
              <circle
                cx={cx}
                cy={cy}
                r="4.5"
                fill="#141516"
                stroke="rgba(255,255,255,.5)"
                strokeWidth="1.6"
              />
            ) : (
              <circle cx={cx} cy={cy} r="4.5" fill="rgba(255,255,255,.55)" />
            )}
          </g>
        ))}
      </g>
      <circle
        cx="300"
        cy="300"
        r="128"
        fill="none"
        stroke="rgba(249,195,26,.42)"
        strokeWidth="1.2"
        strokeDasharray="2 9"
      />
      {SIGNALS.map(([cx, cy]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="4"
          fill={yellow}
          style={{ filter: `drop-shadow(0 0 5px ${yellow})` }}
        />
      ))}
      <circle cx="300" cy="300" r="108" fill="#0B0B0B" stroke="rgba(255,255,255,.1)" />
      {markUrl ? (
        <image href={markUrl} x="208" y="208" width="184" height="184" />
      ) : (
        <foreignObject x="222" y="222" width="156" height="156">
          <div className="flex size-full items-center justify-center text-white">
            <CrewhallMark size={132} />
          </div>
        </foreignObject>
      )}
      <circle
        cx="470"
        cy="300"
        r="5"
        fill={yellow}
        style={{ filter: `drop-shadow(0 0 6px ${yellow})` }}
      />
      <circle cx="210" cy="210" r="3.5" fill="rgba(255,255,255,.5)" />
    </svg>
  );
}
