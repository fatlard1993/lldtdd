import { realpathSync } from "fs";
import { resolve, relative, isAbsolute } from "path";

/** Whether `target` resolves to a location inside one of `bases`, with symlinks followed.
 *
 *  This is the one boundary that keeps reading a document's module -- and the modules it imports --
 *  from turning into reading arbitrary files. It is shared by the document's own module pointer
 *  (parser.ts) and the transitive-import walk (ast/moduleResolution.ts) so the two cannot disagree
 *  about what "inside the project" means.
 *
 *  Symlinks are followed on both the target and the bases. Lexical containment -- comparing the
 *  resolved path strings -- is enough for the reader's own tree, but a document under review is not
 *  the reader's tree: git tracks symlinks, so a foreign repo can commit `mod.ts -> ../../etc/passwd`
 *  inside an allowed directory, and the lexical path stays inside while the bytes read come from
 *  outside. A link is contained only if what it points at is. Paths that do not exist are compared
 *  lexically, since there is nothing there to read and so nothing to escape to. */
export function isContained(target: string, bases: string[]): boolean {
  const real = (p: string) => {
    try { return realpathSync.native(p); } catch { return resolve(p); }
  };
  const realTarget = real(target);
  return bases.some(base => {
    const realBase = real(base);
    const rel = relative(realBase, realTarget);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
