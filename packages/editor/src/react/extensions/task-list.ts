import { mergeAttributes, Node, wrappingInputRule } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    taskList: {
      /** Toggles a task list around the current block. */
      toggleTaskList: () => ReturnType;
    };
  }
}

/** `- [ ] ` / `[x] ` at the start of a line starts a task list. */
const inputRegex = /^\s*(\[([( |x])?\])\s$/;

/** GFM task list (`- [ ] item`). Same names and attributes as Tiptap's TaskList. */
export const TaskList = Node.create({
  name: 'taskList',
  group: 'block list',
  content: 'taskItem+',

  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]', priority: 51 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes, { 'data-type': 'taskList' }), 0];
  },

  addCommands() {
    return {
      toggleTaskList:
        () =>
        ({ commands }) =>
          commands.toggleList(this.name, 'taskItem'),
    };
  },

  addKeyboardShortcuts() {
    return { 'Mod-Shift-9': () => this.editor.commands.toggleTaskList() };
  },
});

/** A task with a `checked` attribute; content is `paragraph block*` like a list item. */
export const TaskItem = Node.create({
  name: 'taskItem',
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-checked');
          return v === '' || v === 'true';
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-checked': attrs.checked === true ? 'true' : 'false',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'li[data-type="taskItem"]',
        priority: 51,
        contentElement: (el: HTMLElement) => el.querySelector('div') ?? el,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'li',
      mergeAttributes(HTMLAttributes, { 'data-type': 'taskItem' }),
      [
        'label',
        { contenteditable: 'false' },
        ['input', { type: 'checkbox', checked: node.attrs.checked ? 'checked' : null }],
      ],
      ['div', 0],
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
    };
  },

  addNodeView() {
    return ({ node: initial, getPos, editor }) => {
      let node = initial;
      const li = document.createElement('li');
      li.setAttribute('data-type', 'taskItem');
      const label = document.createElement('label');
      label.contentEditable = 'false';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const content = document.createElement('div');
      label.append(checkbox);
      li.append(label, content);

      const sync = () => {
        const checked = node.attrs.checked === true;
        checkbox.checked = checked;
        li.dataset.checked = String(checked);
        checkbox.disabled = !editor.isEditable;
      };
      sync();

      checkbox.addEventListener('mousedown', (e) => e.preventDefault());
      checkbox.addEventListener('change', () => {
        if (!editor.isEditable) {
          checkbox.checked = !checkbox.checked;
          return;
        }
        const checked = checkbox.checked;
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            const pos = getPos();
            if (typeof pos !== 'number') return false;
            const current = tr.doc.nodeAt(pos);
            tr.setNodeMarkup(pos, undefined, { ...current?.attrs, checked });
            return true;
          })
          .run();
      });

      return {
        dom: li,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          node = updated;
          sync();
          return true;
        },
      };
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: inputRegex,
        type: this.type,
        getAttributes: (match) => ({ checked: match[match.length - 1] === 'x' }),
      }),
    ];
  },
});
