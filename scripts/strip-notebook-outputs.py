"""Strip outputs from every notebook tracked or staged by Git."""

from __future__ import annotations

import subprocess


def main() -> None:
    """Run nbstripout over all notebooks known to the repository index."""
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.ipynb"],
        check=True,
        stdout=subprocess.PIPE,
    )
    notebooks = [path.decode() for path in result.stdout.split(b"\0") if path]
    if notebooks:
        subprocess.run(["nbstripout", "--", *notebooks], check=True)


if __name__ == "__main__":
    main()
