import fs from "node:fs";
import path from "node:path";
import type { JobType, Tier } from "../types.js";

// Templates are .md files in src/router/templates/ — they aren't bundled into dist/.
// Resolve from process.cwd() which is the .openclaw project root when running the gateway.
const templatesDir = path.join(process.cwd(), "src", "router", "templates");

// In-memory cache: key is "tier/jobType", value is the raw template string.
const templateCache = new Map<string, string>();

/**
 * Load a template file for the given tier and job type.
 * Templates are cached in memory after first read (they don't change at runtime).
 *
 * @throws Error if the template file does not exist.
 */
export function getTemplate(tier: Tier, jobType: JobType): string {
  const cacheKey = `${tier}/${jobType}`;
  const cached = templateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const templatePath = path.join(templatesDir, tier, `${jobType}.md`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Template not found: ${cacheKey} (expected at ${templatePath})`,
    );
  }

  const content = fs.readFileSync(templatePath, "utf-8");
  templateCache.set(cacheKey, content);
  return content;
}

/**
 * Replace `{variable}` placeholders in a template with actual values.
 * Unknown variables (not present in the `variables` map) are left as-is.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]
      : match;
  });
}

/**
 * Clear the template cache. Primarily useful for testing.
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}
