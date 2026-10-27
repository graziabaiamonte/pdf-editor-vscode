// Colour choices shown in the toolbar. Edit, add or remove entries here, then run `npm run build`.
// rgb: red, green, blue, each from 0 to 1 (e.g. [1, 0.85, 0] = yellow). The first entry is the default.
export type ColorOption = { name: string; rgb: [number, number, number] };

export const HIGHLIGHT_COLORS: ColorOption[] = [
  { name: 'Yellow', rgb: [1, 0.85, 0] },
  { name: 'Green', rgb: [0.55, 0.9, 0.45] },
  { name: 'Blue', rgb: [0.45, 0.75, 1] },
  { name: 'Pink', rgb: [1, 0.6, 0.8] },
];

export const UNDERLINE_COLORS: ColorOption[] = [
  { name: 'Red', rgb: [0.9, 0.1, 0.1] },
  { name: 'Blue', rgb: [0.1, 0.35, 0.9] },
  { name: 'Green', rgb: [0.1, 0.6, 0.2] },
  { name: 'Black', rgb: [0, 0, 0] },
];
