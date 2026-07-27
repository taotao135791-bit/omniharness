import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@earendil-works/pi-tui";

/**
 * Minimal ANSI styling. pi-tui components take plain `(text) => string`
 * stylers, so the whole theme is raw escape codes — no chalk dependency.
 */

const wrap = (open: string) => (s: string) => `[${open}m${s}[0m`;

export const fg = {
  black: wrap("30"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  white: wrap("37"),
  gray: wrap("90"),
  brightRed: wrap("91"),
  brightGreen: wrap("92"),
  brightYellow: wrap("93"),
  brightBlue: wrap("94"),
  brightMagenta: wrap("95"),
  brightCyan: wrap("96"),
} as const;

export const bold = wrap("1");
export const dim = wrap("2");
export const italic = wrap("3");
export const underline = wrap("4");
export const inverse = wrap("7");

export function bgBlue(s: string): string {
  return `[44m[37m${s}[0m`;
}

export const mdTheme: MarkdownTheme = {
  heading: (t) => bold(fg.brightCyan(t)),
  link: (t) => underline(fg.cyan(t)),
  linkUrl: (t) => dim(t),
  code: (t) => fg.yellow(t),
  codeBlock: (t) => fg.white(t),
  codeBlockBorder: (t) => fg.gray(t),
  quote: (t) => italic(fg.gray(t)),
  quoteBorder: (t) => fg.gray(t),
  hr: (t) => fg.gray(t),
  listBullet: (t) => fg.cyan(t),
  bold: (t) => bold(t),
  italic: (t) => italic(t),
  strikethrough: (t) => dim(t),
  underline: (t) => underline(t),
};

export const selectTheme: SelectListTheme = {
  selectedPrefix: (t) => fg.cyan(t),
  selectedText: (t) => bold(fg.brightCyan(t)),
  description: (t) => fg.gray(t),
  scrollInfo: (t) => fg.gray(t),
  noMatch: (t) => fg.yellow(t),
};

export const editorTheme: EditorTheme = {
  borderColor: (t) => fg.gray(t),
  selectList: selectTheme,
};

export const settingsTheme: SettingsListTheme = {
  label: (t, selected) => (selected ? bold(fg.brightCyan(t)) : t),
  value: (t, selected) => (selected ? fg.brightYellow(t) : fg.yellow(t)),
  description: (t) => fg.gray(t),
  cursor: fg.cyan("❯"),
  hint: (t) => dim(t),
};
