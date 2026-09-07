/* babel-preset-solid compiles JSX into direct renderer calls, so
 * nothing imports a jsx-runtime at runtime. This file exists only so
 * that an editor or a type checker pointed at `yeetkit` by
 * `jsxImportSource` resolves.
 */
export { createComponent as jsx, createComponent as jsxs, createComponent as jsxDEV } from "./renderer.js";
export const Fragment = (props) => props.children;
