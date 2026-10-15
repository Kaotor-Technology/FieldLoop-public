"""Reject direct generative provider calls in production Python sources (GR-1)."""

import ast
import re
import subprocess
from pathlib import Path

PROVIDER_MODULES = ("google.genai", "google.generativeai", "google.cloud.aiplatform", "vertexai")
GENERATION_METHODS = {
    "generate_content", "generate_content_stream", "generateContent", "generateContentStream",
    "send_message", "send_message_stream",
}
PROVIDER_ENDPOINT = re.compile(
    r"aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com|api\.(openai|anthropic)\.com"
)
EMBEDDING_ADAPTER = "packages/adapters/python/src/fieldloop_adapters/embeddings.py"
# Re-exports data types only (Content, Part, HttpOptions); generation methods stay rejected.
ADK_TYPES_ADAPTER = "packages/adapters/python/src/fieldloop_adapters/adk_types.py"
PROVIDER_IMPORT_ALLOWED = {EMBEDDING_ADAPTER, ADK_TYPES_ADAPTER}


def check_python_boundary(path: str, source: str) -> list[str]:
    errors = []
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        return [f"{path}:{error.lineno}: Python source cannot be checked: {error.msg}"]
    for node in ast.walk(tree):
        modules = []
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            modules = [node.module or ""] + [
                f"{node.module}.{alias.name}" for alias in node.names
            ]
        imports_provider = any(
            module == provider or module.startswith(provider + ".")
            for module in modules for provider in PROVIDER_MODULES
        )
        if (
            isinstance(node, (ast.Import, ast.ImportFrom))
            and path not in PROVIDER_IMPORT_ALLOWED and imports_provider
        ):
            errors.append(f"{path}:{node.lineno}: Provider SDK belongs in adapters (GR-1)")
        if isinstance(node, ast.Attribute) and node.attr in GENERATION_METHODS:
            errors.append(f"{path}:{node.lineno}: Generative call must use Guardrail (GR-1)")
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if PROVIDER_ENDPOINT.search(node.value):
                errors.append(
                    f"{path}:{node.lineno}: Direct model endpoint bypasses Guardrail (GR-1)"
                )
    return errors


def main() -> int:
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], text=True
    ).split("\0")
    errors = []
    for path in sorted(set(paths)):
        parts = Path(path).parts
        if (not parts or parts[0] not in {"apps", "packages", "py"} or "src" not in parts
                or not path.endswith(".py") or any(
                    part in {"raw-data", "node_modules", "dist", "tests", "test", "fixtures"}
                    for part in parts
                )):
            continue
        errors.extend(check_python_boundary(path, Path(path).read_text(encoding="utf-8")))
    if errors:
        print("\n".join(errors))
        return 1
    print("Python model calls respect the Guardrail boundary (GR-1); embeddings stay in adapters.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
