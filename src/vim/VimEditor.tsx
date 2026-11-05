// The text field with Vim: CodeMirror and @replit/codemirror-vim, loaded only when Vim is on.
import { useEffect, useEffectEvent, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder as placeholderText } from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Vim, getCM, vim as vimKeys } from "@replit/codemirror-vim";

/** The extension gave the view its engine state as the view was made. */
const cmOf = (view: EditorView) => getCM(view) as Parameters<typeof Vim.handleEx>[0];

const hint = new Compartment();

/**
 * A multi-line text field. The text is the editor's own: `initial` is read once, and a change that does not come from
 * typing takes a new `key`. A parent's state can lag behind what is being composed, and writing it back would break
 * the composition.
 */
export default function VimEditor({
  id,
  className,
  initial,
  label,
  placeholder,
  autoFocus,
  onChange,
  onWrite,
  onMode,
  onBlur,
}: {
  /** Goes on the editable element, as a textarea's would. */
  id?: string;
  className: string;
  initial: string;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  onChange: (text: string) => void;
  /** Ctrl+Enter. */
  onWrite: (text: string) => void;
  onMode: (mode: string) => void;
  onBlur?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);

  const changed = useEffectEvent(onChange);
  const write = useEffectEvent(onWrite);
  const mode = useEffectEvent(onMode);
  const blurred = useEffectEvent(() => onBlur?.());

  const report = useEffectEvent((view: EditorView) => {
    const state = getCM(view)?.state.vim;
    if (state) {
      const waiting = !state.insertMode && (state.inputState.keyBuffer.length > 0 || state.inputState.operator);
      mode(`${(state.mode ?? "normal").toUpperCase()}${waiting ? ` ${state.status}` : ""}`);
      // The engine clears its record of the keys only when a command runs, not when they add up to nothing.
      if (!waiting) {
        state.status = "";
      }
    }
  });

  const create = useEffectEvent((parent: HTMLElement) => {
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial,
        selection: { anchor: initial.length },
        extensions: [
          vimKeys(),
          history(),
          drawSelection(),
          keymap.of([...standardKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          hint.of(placeholderText(placeholder)),
          EditorView.contentAttributes.of({ ...(id ? { id } : {}), "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              changed(u.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({ blur: () => blurred() }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e, v) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  write(v.state.doc.toString());
                  return true;
                }
                return false;
              },
            }),
          ),
          // Past the engine only with a key it did not use, of which it says nothing: Esc after `d` ends the wait on the badge too.
          Prec.low(EditorView.domEventHandlers({ keydown: (_, v) => report(v) })),
        ],
      }),
    });
    const cm = cmOf(view);
    for (const event of ["vim-mode-change", "vim-keypress", "vim-command-done"]) {
      cm.on(event, () => report(view));
    }
    // A field is for typing, and `startinsert` is out of reach of a mapping of `i`.
    Vim.handleEx(cm, "startinsert");
    if (autoFocus) {
      view.focus();
    }
    return view;
  });

  useEffect(() => {
    const view = create(host.current!);
    editor.current = view;
    return () => view.destroy();
  }, []);
  useEffect(() => {
    editor.current?.dispatch({ effects: hint.reconfigure(placeholderText(placeholder)) });
  }, [placeholder]);

  return <div ref={host} className={className} />;
}
