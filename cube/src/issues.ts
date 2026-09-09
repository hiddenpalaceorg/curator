/** A line-accurate problem found while parsing, validating, or saving a document. */
export type Issue = {
  severity: "error" | "warning";
  /** Stable machine-readable rule id, e.g. "unknown-component", "attr-type". */
  rule: string;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  component?: string;
  attr?: string;
};

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

type PositionLike = {
  start?: { line?: number; column?: number };
  end?: { line?: number; column?: number };
};

/** Copy position info from an mdast node onto an issue. */
export function at(issue: Issue, pos: PositionLike | undefined): Issue {
  if (pos?.start) {
    issue.line = pos.start.line;
    issue.column = pos.start.column;
  }
  if (pos?.end) {
    issue.endLine = pos.end.line;
    issue.endColumn = pos.end.column;
  }
  return issue;
}

export class CubeValidationError extends Error {
  issues: Issue[];
  constructor(issues: Issue[]) {
    const errors = issues.filter((i) => i.severity === "error");
    super(
      `${errors.length} validation error${errors.length === 1 ? "" : "s"}` +
        (errors[0] ? `: ${errors[0].message}` : ""),
    );
    this.name = "CubeValidationError";
    this.issues = issues;
  }
}

export class CubeAuthorizationError extends Error {
  constructor() {
    super("not allowed to write this page");
    this.name = "CubeAuthorizationError";
  }
}

export class CubeConflictError extends Error {
  currentRevId: number;
  currentContent: string;
  baseContent: string;
  constructor(currentRevId: number, currentContent: string, baseContent: string) {
    super(`edit conflict: page head is r${currentRevId}, not the base revision`);
    this.name = "CubeConflictError";
    this.currentRevId = currentRevId;
    this.currentContent = currentContent;
    this.baseContent = baseContent;
  }
}
