// Cross-OS path hygiene (audit item 10). Everything keeldocs EMITS - doc
// paths in findings, provenance sources, the envelope's `full` pointer, the
// registry's provider dirs - is posix-slash BY CONTRACT, so fact files,
// reports, and goldens stay byte-identical across OS. Native separators are
// confined to fs calls. The `sep` guard matters: on posix a backslash is a
// legal filename byte, so splitting there would corrupt real names.
import { sep } from "node:path";

export const toPosix = (p) => (sep === "/" ? p : p.split(sep).join("/"));
