import { dirname, resolve } from "node:path";

// Validate provenance after resolution: a look-alike or another file's Problem
// must not pass, while response aliases and allOf extensions remain valid.
export default function sharedProblem(schema, _options, context) {
  const rulesetSource = context.rule.owner.source;
  const canonicalSource = rulesetSource === null ? null : resolve(dirname(rulesetSource), "openapi.yaml");
  const includesSharedProblem = (value, path) => {
    const origin = context.documentInventory.findAssociatedItemForPath(path, true);
    if (canonicalSource !== null && origin?.document.source === canonicalSource
      && origin.path.join("/") === "components/schemas/Problem") return true;
    return Array.isArray(value?.allOf)
      && value.allOf.some((member, index) => includesSharedProblem(member, [...path, "allOf", index]));
  };
  if (!includesSharedProblem(schema, context.path)) {
    return [{ message: "An error body must reference the canonical openapi.yaml Problem, directly or through allOf.", path: context.path }];
  }
}
