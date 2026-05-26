#!/usr/bin/env python3
"""Print comments and review threads for the current branch's open PR."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import textwrap
from typing import Any


GRAPHQL_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      comments(first: 100) {
        pageInfo {
          hasNextPage
        }
        nodes {
          author { login }
          body
          url
          createdAt
        }
      }
      reviewThreads(first: 100) {
        pageInfo {
          hasNextPage
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              author { login }
              body
              url
              path
              line
              originalLine
              outdated
              createdAt
            }
          }
        }
      }
    }
  }
}
""".strip()


class GhError(RuntimeError):
    pass


def run_gh(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["gh", *args],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise GhError(
            "GitHub CLI (`gh`) was not found. Install gh and authenticate with `gh auth login`."
        ) from exc

    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise GhError(detail or f"`gh {' '.join(args)}` failed with exit code {result.returncode}.")

    return result


def load_json_from_gh(args: list[str], error_context: str) -> Any:
    result = run_gh(args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GhError(f"{error_context}: gh returned invalid JSON.") from exc


def ensure_gh_auth() -> None:
    result = run_gh(["auth", "status"], check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise GhError(
            "GitHub CLI is not authenticated or cannot reach GitHub. "
            "Run `gh auth login`, then try again.\n"
            + detail
        )


def find_pr_number(explicit_pr: int | None) -> int:
    if explicit_pr is not None:
        return explicit_pr

    result = run_gh(["pr", "view", "--json", "number"], check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise GhError(
            "No open PR was found for the current branch. "
            "Push the branch and open a PR, or pass `--pr <number>`.\n"
            + detail
        )

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GhError("Could not parse `gh pr view` output while finding the PR.") from exc

    number = data.get("number")
    if not isinstance(number, int):
        raise GhError("No PR number was returned by `gh pr view`. Try `--pr <number>`.")
    return number


def repo_owner_name() -> tuple[str, str]:
    data = load_json_from_gh(["repo", "view", "--json", "owner,name"], "Could not read repo info")
    owner = data.get("owner", {}).get("login")
    name = data.get("name")
    if not owner or not name:
        raise GhError("Could not determine repository owner/name from `gh repo view`.")
    return owner, name


def fetch_pr(owner: str, name: str, number: int) -> dict[str, Any]:
    data = load_json_from_gh(
        [
            "api",
            "graphql",
            "-f",
            f"query={GRAPHQL_QUERY}",
            "-F",
            f"owner={owner}",
            "-F",
            f"name={name}",
            "-F",
            f"number={number}",
        ],
        "Could not fetch PR comments",
    )
    pr = data.get("data", {}).get("repository", {}).get("pullRequest")
    if not pr:
        raise GhError(f"PR #{number} was not found in {owner}/{name}.")
    return pr


def author_name(node: dict[str, Any]) -> str:
    return node.get("author", {}).get("login") or "unknown"


def short_body(body: str, *, width: int = 88, max_lines: int = 8) -> str:
    cleaned = "\n".join(line.rstrip() for line in body.strip().splitlines()).strip()
    if not cleaned:
        return "(empty body)"

    lines = cleaned.splitlines()
    truncated = len(lines) > max_lines
    lines = lines[:max_lines]
    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(textwrap.wrap(line, width=width) or [""])
    if truncated:
        wrapped.append("...")
    return "\n".join(wrapped)


def location_for_thread(thread: dict[str, Any]) -> str:
    path = thread.get("path")
    line = thread.get("line") or thread.get("originalLine")
    start = thread.get("startLine") or thread.get("originalStartLine")
    if path and start and line and start != line:
        return f"{path}:{start}-{line}"
    if path and line:
        return f"{path}:{line}"
    if path:
        return path
    return "no file location"


def location_for_comment(comment: dict[str, Any], fallback: str) -> str:
    path = comment.get("path") or fallback
    line = comment.get("line") or comment.get("originalLine")
    if path and line:
        return f"{path}:{line}"
    return path or "no file location"


def print_block(prefix: str, body: str) -> None:
    for line in body.splitlines():
        print(f"    {prefix}{line}")


def print_pr_comments(comments: list[dict[str, Any]]) -> None:
    print(f"\nPR comments ({len(comments)})")
    if not comments:
        print("  None")
        return

    for index, comment in enumerate(comments, start=1):
        print(f"  {index}. {author_name(comment)}")
        if comment.get("createdAt"):
            print(f"     created: {comment['createdAt']}")
        if comment.get("url"):
            print(f"     url: {comment['url']}")
        print("     body:")
        print_block("", short_body(comment.get("body") or ""))


def print_review_threads(threads: list[dict[str, Any]]) -> None:
    print(f"\nReview threads ({len(threads)})")
    if not threads:
        print("  None")
        return

    for index, thread in enumerate(threads, start=1):
        comments = thread.get("comments", {}).get("nodes", [])
        status = []
        if "isResolved" in thread:
            status.append("resolved" if thread["isResolved"] else "unresolved")
        if "isOutdated" in thread:
            status.append("outdated" if thread["isOutdated"] else "current")

        print(f"  {index}. {location_for_thread(thread)}")
        if status:
            print(f"     status: {', '.join(status)}")
        print(f"     comments: {len(comments)}")

        for comment_index, comment in enumerate(comments, start=1):
            print(f"     {index}.{comment_index} {author_name(comment)}")
            print(f"       location: {location_for_comment(comment, thread.get('path') or '')}")
            if "outdated" in comment:
                print(f"       status: {'outdated' if comment['outdated'] else 'current'}")
            if comment.get("createdAt"):
                print(f"       created: {comment['createdAt']}")
            if comment.get("url"):
                print(f"       url: {comment['url']}")
            print("       body:")
            print_block("", short_body(comment.get("body") or ""))


def warn_if_partial(pr: dict[str, Any]) -> None:
    warnings: list[str] = []
    if pr.get("comments", {}).get("pageInfo", {}).get("hasNextPage"):
        warnings.append("PR comments")
    if pr.get("reviewThreads", {}).get("pageInfo", {}).get("hasNextPage"):
        warnings.append("review threads")

    partial_thread_comments = [
        location_for_thread(thread)
        for thread in pr.get("reviewThreads", {}).get("nodes", [])
        if thread.get("comments", {}).get("pageInfo", {}).get("hasNextPage")
    ]
    if partial_thread_comments:
        warnings.append(
            "thread comments for " + ", ".join(partial_thread_comments[:5])
        )

    if warnings:
        print(
            "\nwarning: partial output; GitHub returned more results than this script fetched for "
            + "; ".join(warnings)
            + "."
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch PR comments and review threads for the current branch."
    )
    parser.add_argument("--pr", type=int, help="PR number to inspect instead of the current branch PR.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        ensure_gh_auth()
        number = find_pr_number(args.pr)
        owner, name = repo_owner_name()
        pr = fetch_pr(owner, name, number)
    except GhError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"{owner}/{name} PR #{pr['number']}: {pr['title']}")
    print(pr["url"])
    warn_if_partial(pr)
    print_pr_comments(pr.get("comments", {}).get("nodes", []))
    print_review_threads(pr.get("reviewThreads", {}).get("nodes", []))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
