export interface InterpolationContext {
  home: string;
  projectPath: string;
  projectName: string;
  env: Record<string, string>;
}

const TOKEN = /\$\{(HOME|PROJECT_PATH|PROJECT_NAME|env\.[A-Za-z_][A-Za-z0-9_]*)\}/g;

function replace(input: string, ctx: InterpolationContext): string {
  return input.replace(TOKEN, (_m, key: string) => {
    if (key === 'HOME') return ctx.home;
    if (key === 'PROJECT_PATH') return ctx.projectPath;
    if (key === 'PROJECT_NAME') return ctx.projectName;
    if (key.startsWith('env.')) return ctx.env[key.slice(4)] ?? '';
    return '';
  });
}

export function interpolateArgv(argv: string[], ctx: InterpolationContext): string[] {
  return argv.map(a => replace(a, ctx));
}

export function interpolateEnv(env: Record<string, string>, ctx: InterpolationContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = replace(v, ctx);
  return out;
}
