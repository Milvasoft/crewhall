export {
  INCOMING,
  JOINED,
  LEFT,
  loudness,
  MENTION,
  MESSAGE,
  RINGBACK,
  RINGTONE_FILES,
  RINGTONES,
  renderRingtone,
  type RingNote,
  type Ringtone,
  type RingtoneName,
} from './ringtones';
export { encodeWav } from './wav';

/** Sample rate of the generated files (the mallet and the room need the full band). */
export const SOUND_SAMPLE_RATE = 44_100;
