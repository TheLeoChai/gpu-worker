"""Mechanical import closure for transfer bundles (LEO-180).

Hand-maintained dependency lists miss deferred imports (imports inside
functions, `importlib.import_module("x")`). This walks the full AST of each
entry script and, transitively, of every project module it reaches, resolving
names against the given search paths inside the repo tree.

    python import_closure.py ENTRY.py [ENTRY2.py ...] --root REPO
        [--path tools --path scripts/model_bakeoff]   # sys.path dirs, relative to REPO
        [--bundle DIR]                                # verify a staged/extracted bundle
        [--out import_map.json]

Search paths default to each entry script's directory plus REPO. Output (JSON):
  modules            project modules in the closure: path (relative to REPO), sha256, imported_by
  missing_project    imported names that exist somewhere in REPO but not on the search path
                     (the construct_delivery_synthetic failure) -> exit 1
  external           names resolved to neither the repo nor the stdlib (third-party deps)
  bundle             with --bundle: closure files absent from the bundle or with different bytes -> exit 1
Stdlib-only; run it on the bundle builder, before submitting the job.
"""
import argparse
import ast
import hashlib
import json
import os
import sys
from pathlib import Path

STDLIB = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names) | {"__future__"}
# never project code: virtualenvs (.venv*, venv), installed packages, caches
SKIP_DIRS = {"venv", "env", "node_modules", "__pycache__", "site-packages", "dist-packages"}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def imported_names(tree, module_pkg):
    """Yield (absolute_dotted_name, lineno, from_names) for every import anywhere in the tree."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, node.lineno, ()
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = module_pkg.split(".") if module_pkg else []
                keep = len(parts) - (node.level - 1)
                if keep < 0:
                    continue
                base = ".".join(parts[:keep] + ([base] if base else []))
            if base:
                yield base, node.lineno, tuple(a.name for a in node.names if a.name != "*")
        elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else None
            if name in ("import_module", "__import__"):
                yield node.args[0].value, node.lineno, ()


class Closure:
    def __init__(self, root, search):
        self.root = root
        self.search = search
        self.modules = {}    # dotted name -> {"path", "imported_by"}
        self.missing = {}    # top-level name -> [importer:line]
        self.external = {}
        self._repo_names = None

    def resolve(self, dotted):
        parts = dotted.split(".")
        for base in self.search:
            candidates = [base.joinpath(*parts).with_suffix(".py"), base.joinpath(*parts, "__init__.py")]
            for c in candidates:
                if c.is_file():
                    return base, c
        return None, None

    def repo_names(self):
        if self._repo_names is None:
            names = set()
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
                for f in filenames:
                    if f == "__init__.py":
                        names.add(os.path.basename(dirpath))
                    elif f.endswith(".py"):
                        names.add(f[:-3])
            self._repo_names = names
        return self._repo_names

    def package_of(self, path):
        for base in self.search:
            try:
                rel = path.relative_to(base)
            except ValueError:
                continue
            # pkg/mod.py and pkg/__init__.py both live in package "pkg"
            return ".".join(rel.with_suffix("").parts[:-1])
        return ""

    def add(self, dotted, path, importer):
        rec = self.modules.setdefault(dotted, {"path": path, "imported_by": []})
        if importer not in rec["imported_by"]:
            rec["imported_by"].append(importer)

    def walk(self, entries):
        queue = []
        for e in entries:
            self.modules.setdefault("__entry__:" + self.rel(e), {"path": e, "imported_by": []})
            queue.append(e)
        seen = set()
        while queue:
            path = queue.pop()
            if path in seen:
                continue
            seen.add(path)
            tree = ast.parse(path.read_bytes(), filename=str(path))
            pkg = self.package_of(path)
            for dotted, line, from_names in imported_names(tree, pkg):
                where = "%s:%d" % (self.rel(path), line)
                targets = [dotted] + [dotted + "." + n for n in from_names]
                # every ancestor package's __init__ runs on import too
                parts = dotted.split(".")
                targets += [".".join(parts[:i]) for i in range(1, len(parts))]
                hit = False
                for name in targets:
                    _, found = self.resolve(name)
                    if found:
                        hit = True
                        self.add(name, found, where)
                        queue.append(found)
                if not hit:
                    top = parts[0]
                    if top in STDLIB:
                        continue
                    bucket = self.missing if top in self.repo_names() else self.external
                    bucket.setdefault(top, [])
                    if where not in bucket[top]:
                        bucket[top].append(where)

    def rel(self, path):
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return str(path)


def main(argv=None):
    p = argparse.ArgumentParser(description="Mechanical import closure for transfer bundles")
    p.add_argument("entries", nargs="+", type=Path)
    p.add_argument("--root", type=Path, required=True, help="repo root the bundle is cut from")
    p.add_argument("--path", action="append", default=[], help="extra sys.path dir, relative to --root")
    p.add_argument("--bundle", type=Path, help="extracted bundle dir to verify against the closure")
    p.add_argument("--out", type=Path, help="write the JSON report here as well as stdout")
    a = p.parse_args(argv)

    root = a.root.resolve()
    entries = [e.resolve() for e in a.entries]
    search = []
    for d in [root / x for x in a.path] + [e.parent for e in entries] + [root]:
        d = d.resolve()
        if d not in search:
            search.append(d)

    c = Closure(root, search)
    c.walk(entries)
    modules = {}
    for name, rec in sorted(c.modules.items()):
        modules[name] = {"path": c.rel(rec["path"]), "sha256": sha256(rec["path"]), "imported_by": sorted(rec["imported_by"])}
    report = {
        "root": str(root),
        "search_path": [c.rel(s) or "." for s in search],
        "entries": [c.rel(e) for e in entries],
        "project_count": sum(1 for n in modules if not n.startswith("__entry__:")),
        "modules": modules,
        "missing_project": c.missing,
        "external": c.external,
    }
    ok = not c.missing
    if a.bundle:
        bundle = a.bundle.resolve()
        absent, differ = [], []
        for rec in modules.values():
            f = bundle / rec["path"]
            if not f.is_file():
                absent.append(rec["path"])
            elif sha256(f) != rec["sha256"]:
                differ.append(rec["path"])
        report["bundle"] = {"dir": str(bundle), "absent": sorted(set(absent)), "sha_mismatch": sorted(set(differ))}
        ok = ok and not absent and not differ
    report["ok"] = ok
    text = json.dumps(report, indent=2)
    if a.out:
        a.out.write_text(text + "\n")
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
