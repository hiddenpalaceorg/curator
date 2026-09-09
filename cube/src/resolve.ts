import type { Cube, ResolveResult } from "./index";
import type { PagePolicyInput } from "./auth/native";

/** Resolution metadata belongs to both the requested page and its target. */
export async function canReadResolution(
  cube: Cube,
  resolved: ResolveResult,
  canRead: (page: PagePolicyInput) => boolean | Promise<boolean>,
): Promise<boolean> {
  const refs = resolved.redirectedFrom ? [resolved.redirectedFrom, resolved] : [resolved];
  for (const ref of refs) {
    const page = await cube.api.getPage(ref);
    if (!page || !(await canRead(page))) return false;
  }
  return true;
}
