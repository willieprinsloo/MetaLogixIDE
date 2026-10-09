/** Pure model for the project Env tab's read-only "From app settings" list. */

export interface InheritedEnvRow {
  name: string;
  value: string;
  overridden: boolean;
}

/** App-wide rows in stored order; `overridden` when the project's saved map has the name (AC18, A8). */
export function inheritedRows(
  appEnv: Readonly<Record<string, string>>,
  projectSaved: Readonly<Record<string, string>> | undefined,
): InheritedEnvRow[] {
  return Object.entries(appEnv).map(([name, value]) => ({
    name,
    value,
    overridden: projectSaved !== undefined && Object.prototype.hasOwnProperty.call(projectSaved, name),
  }));
}
