// What the console's editor (src/web/js/dock-editor.js) takes from CodeMirror; see scripts/build-vendor.mjs.
export { EditorView, keymap } from '@codemirror/view';
export { EditorState, Compartment } from '@codemirror/state';
export { basicSetup } from 'codemirror';
export { indentWithTab } from '@codemirror/commands';
export { LanguageDescription, syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
export { languages } from '@codemirror/language-data';
export { oneDarkTheme, oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
export { unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
