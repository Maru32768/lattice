// The text field with Vim: CodeMirror and @replit/codemirror-vim, loaded only when Vim is on. What touches the engine
// is global to it: mappings, options and Ex commands apply to every editor in the window.
import { useEffect, useEffectEvent, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder as placeholderText } from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Vim, getCM, vim as vimKeys } from "@replit/codemirror-vim";
import { EX_ALIASES, type ActionId } from "../lib/keymap";
import { getVimrc, useVimrc, vimBridge } from "./vim";
import { KNOWN, mappedKeys, parseVimrc } from "./vimrc";

/** The extension gave the view its engine state as the view was made. */
const cmOf = (view: EditorView) => getCM(view) as Parameters<typeof Vim.handleEx>[0];

// ---- Ex commands -------------------------------------------------------------------------------

/** `Vim.defineEx` is global: what `:w` and `:q` mean is each editor's own. */
const commands = new WeakMap<EditorView, { write: () => void; quit: () => void }>();

/** The engine refocuses the editor after it runs a command from its prompt: what moves the focus has to wait for that. */
const afterPrompt = (f: () => void) => queueMicrotask(f);

Vim.defineEx("write", "w", (cm) => afterPrompt(() => commands.get(cm.cm6 as EditorView)?.write()));
Vim.defineEx("quit", "q", (cm) => afterPrompt(() => commands.get(cm.cm6 as EditorView)?.quit()));

const WINCMD: Record<string, ActionId> = { h: "paneLeft", j: "paneDown", k: "paneUp", l: "paneRight" };
Vim.defineEx("wincmd", "winc", (_, params) => {
  const arg = params.argString?.trim() ?? "";
  const id = WINCMD[arg] ?? EX_ALIASES[`wincmd${arg}`];
  if (id) {
    afterPrompt(() => vimBridge.run(id));
  }
});
for (const [name, id] of Object.entries(EX_ALIASES)) {
  if (!name.includes("=")) {
    Vim.defineEx(name, undefined, () => afterPrompt(() => vimBridge.run(id)));
  }
}

// ---- vimrc -------------------------------------------------------------------------------------

Vim.defineAction("nop", () => {});
Vim.defineOption("clipboard", "", "string", ["cb"]);

// The engine writes the clipboard only for the `+` register; `set clipboard=unnamed` asks it of a plain yank.
const registers = Vim.getRegisterController();
const pushText = registers.pushText.bind(registers);
registers.pushText = (name, operator, text, linewise, blockwise) => {
  if (!name && operator === "yank" && Vim.getOption("clipboard")) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
  pushText(name, operator, text, linewise, blockwise);
};

// The engine's types want a context where it also takes none, meaning every mode.
const ANY_MODE = undefined as unknown as string;
const MAP_CONTEXT: Record<string, string> = { "": ANY_MODE, n: "normal", v: "visual", i: "insert", o: "operatorPending" };
/** Holds a removed command's place in the keymap: the engine tells its defaults from the user's by counting. */
const UNMAPPED = "<unmapped>";

let applied: string | null = null;
let mapped = mappedKeys([]);

/** Puts `text` in effect for every editor. Idempotent, so each editor can call it as it comes up. */
function applyVimrc(text: string, view: EditorView) {
  if (text === applied) {
    return;
  }
  applied = text;
  const entries = parseVimrc(text, KNOWN);
  mapped = mappedKeys(entries);
  Vim.mapclear();
  // shortcut: other options, and default commands a vimrc removed, stay until the app restarts, upgrade if people edit those and expect them back at once.
  Vim.setOption("clipboard", "");
  for (const e of entries) {
    if (e.kind === "ex" && e.ex.startsWith("unmap ") && Vim.unmap(e.ex.slice("unmap ".length), ANY_MODE)) {
      Vim.mapCommand(UNMAPPED, "idle", "", {}, {});
    }
  }
  for (const e of entries) {
    if (e.kind === "nop") {
      Vim.mapCommand(e.lhs, "action", "nop", {}, e.context ? { context: e.context } : {});
    } else if (e.kind === "ex" && !e.ex.startsWith("unmap ")) {
      // Not through `handleEx`: the engine's `:map` keeps only one word of a right-hand side.
      const map = /^(n|v|i|o|)(nore)?map (\S+) (.*)$/.exec(e.ex);
      if (!map) {
        Vim.handleEx(cmOf(view), e.ex);
      } else if (map[2]) {
        Vim.noremap(map[3]!, map[4]!, MAP_CONTEXT[map[1]!]!);
      } else {
        Vim.map(map[3]!, map[4]!, MAP_CONTEXT[map[1]!]!);
      }
    }
  }
}

vimBridge.owns = (e, editor) => {
  const view = EditorView.findFromDOM(editor as HTMLElement);
  const state = view && getCM(view)?.state.vim;
  const key = state && Vim.vimKeyFromEvent(e, state);
  return !!key && mapped[state.insertMode ? "insert" : state.visualMode ? "visual" : "normal"].has(key);
};

// ---- the editor --------------------------------------------------------------------------------

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
  onQuit,
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
  /** Ctrl+Enter and `:w`. */
  onWrite: (text: string) => void;
  /** `:q`. */
  onQuit: () => void;
  onMode: (mode: string) => void;
  onBlur?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const vimrc = useVimrc();

  const changed = useEffectEvent(onChange);
  const write = useEffectEvent(onWrite);
  const quit = useEffectEvent(onQuit);
  const mode = useEffectEvent(onMode);
  const blurred = useEffectEvent(() => onBlur?.());

  const report = useEffectEvent((view: EditorView) => {
    const state = getCM(view)?.state.vim;
    if (state) {
      const waiting = !state.insertMode && (state.inputState.keyBuffer.some((k) => k !== "<Esc>") || state.inputState.operator);
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
                // Vim gives up on a mapped <Esc><Esc> after a moment and reads the next key afresh. The engine has no
                // such timeout and would swallow that key, and people mash Esc.
                const input = getCM(v)?.state.vim?.inputState;
                if (input?.keyBuffer[0] === "<Esc>" && e.key !== "Escape") {
                  input.keyBuffer.length = 0;
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
    commands.set(view, { write: () => write(view.state.doc.toString()), quit: () => quit() });
    const cm = cmOf(view);
    for (const event of ["vim-mode-change", "vim-keypress", "vim-command-done"]) {
      cm.on(event, () => report(view));
    }
    applyVimrc(getVimrc(), view);
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
    if (editor.current) {
      applyVimrc(vimrc, editor.current);
    }
  }, [vimrc]);
  useEffect(() => {
    editor.current?.dispatch({ effects: hint.reconfigure(placeholderText(placeholder)) });
  }, [placeholder]);

  return <div ref={host} className={className} />;
}
