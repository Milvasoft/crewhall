import {
  getExtensionField,
  type AnyExtension,
  type Extensions,
  type Mark,
  type Node,
} from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';

/**
 * StarterKit's members, adjusted to the document model (src/model.ts):
 * - heading 1-6 with an `id` attribute (custom anchor `{#id}`),
 * - link with only `href` and `title` (markdown cannot store target/rel/class),
 * - orderedList with only `start`,
 * - code mark that may sit inside a link (markdown allows `[`code`](url)`),
 * - no underline (markdown cannot store it), no code block (CodeBlockLowlight replaces it).
 *
 * The members are taken out of StarterKit (instead of importing each package) so that only
 * the packages this one depends on directly are needed.
 */
export function starterKitMembers(options: { undoRedo: boolean }): Extensions {
  const kit = StarterKit.configure({
    codeBlock: false,
    underline: false,
    undoRedo: options.undoRedo ? {} : false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    link: {
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      HTMLAttributes: { target: null, rel: 'noopener noreferrer nofollow', class: null },
    },
    dropcursor: { width: 2, class: 'ch-dropcursor' },
    trailingNode: { notAfter: ['paragraph'] },
  });
  const addExtensions = getExtensionField<(() => Extensions) | undefined>(kit, 'addExtensions', {
    name: kit.name,
    options: kit.options,
    storage: kit.storage,
  });
  const members = addExtensions ? addExtensions() : [];
  return members.map(adjust);
}

function adjust(ext: AnyExtension): AnyExtension {
  switch (ext.name) {
    case 'heading':
      return (ext as Node).extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            id: {
              default: null,
              parseHTML: (el: HTMLElement) => el.getAttribute('id') || null,
              renderHTML: (attrs: Record<string, unknown>) =>
                typeof attrs.id === 'string' && attrs.id ? { id: attrs.id } : {},
            },
          };
        },
      });
    case 'link':
      return (ext as Mark).extend({
        addAttributes() {
          return {
            href: {
              default: null,
              parseHTML: (el: HTMLElement) => el.getAttribute('href'),
            },
            title: {
              default: null,
              parseHTML: (el: HTMLElement) => el.getAttribute('title') || null,
            },
          };
        },
      });
    case 'orderedList':
      return (ext as Node).extend({
        addAttributes() {
          return {
            start: {
              default: 1,
              parseHTML: (el: HTMLElement) =>
                el.hasAttribute('start') ? parseInt(el.getAttribute('start') ?? '', 10) || 1 : 1,
            },
          };
        },
      });
    case 'code':
      // Tiptap's code mark excludes every mark; the model keeps links on inline code.
      return (ext as Mark).extend({ excludes: 'bold italic strike code' });
    default:
      return ext;
  }
}
