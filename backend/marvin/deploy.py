"""Update the existing Space using a locally configured Hugging Face token."""

import argparse
from pathlib import Path

from huggingface_hub import CommitOperationAdd, HfApi

SPACE = "Cashel/diffusion-chatbot"
# The latest reviewed deployment; refuse to overwrite intervening remote edits.
SOURCE_REVISION = "dd8e9d6af19cc2c255966f7828592301a53d5f2f"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-sha", default=SOURCE_REVISION)
    args = parser.parse_args()
    api = HfApi()
    # Uses HF_TOKEN or the normal HF login store. Credentials are never printed.
    api.whoami()
    current = api.repo_info(SPACE, repo_type="space").sha
    if current != args.expected_sha:
        raise SystemExit("The Space changed since the reviewed source. Inspect it before supplying a new --expected-sha.")
    root = Path(__file__).resolve().parent
    result = api.create_commit(
        repo_id=SPACE,
        repo_type="space",
        parent_commit=current,
        commit_message="Measure embeddings, QKV projections and output head for Marvin architecture view",
        operations=[
            CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(root / name))
            for name in ("app.py", "request_queue.py", "telemetry.py", "modeling_qwen3.py", "LICENSE", "requirements.txt", "Dockerfile")
        ],
    )
    print(result.commit_url)


if __name__ == "__main__":
    main()
