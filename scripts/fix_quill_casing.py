from pathlib import Path

root = Path(__file__).resolve().parent.parent
repls = [
    (".quill", ".quill"),
    ("QUILL_", "QUILL_"),
    ("QUILL.md", "QUILL.md"),
    (".quill.md", ".quill.md"),
    ("generate_QUILL_md", "generate_quill_md"),
    ("QUILL_session", "quill_session"),
    ("quillignore", "quillignore"),
    ("_QUILL_", "_quill_"),
]
skip = {"desktop", "node_modules", "dist", "build", ".git", ".venv", "venv"}
for f in root.rglob("*"):
    if not f.is_file() or f.suffix not in {
        ".py", ".toml", ".md", ".sample", ".txt", ".js", ".json", ".html", ".css", ".gitignore"
    }:
        continue
    if any(p in f.parts for p in skip):
        continue
    text = f.read_text(encoding="utf-8")
    orig = text
    for a, b in repls:
        text = text.replace(a, b)
    if text != orig:
        f.write_text(text, encoding="utf-8")
        print("fixed", f.relative_to(root))
