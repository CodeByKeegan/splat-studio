// Applies the persisted color theme at module eval — main.ts's FIRST import,
// so the theme lands before any UI paints.
import { applyActiveTheme } from './theme';

applyActiveTheme();
