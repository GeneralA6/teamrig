/** A GitHub login: letters, digits and single inner hyphens, at most 39, so it can name no other path or field. */
const LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;

/** Whether `login` has the shape of a GitHub login. */
export function isLogin(login: string): boolean {
  return LOGIN.test(login);
}
