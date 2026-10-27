import type { AnchorHTMLAttributes } from "react";
import { Link, useLocation } from "react-router";
import { getEmbeddedSearchEntries, withEmbeddedSearch } from "./gkv/embeddedPath";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & { url: string; external?: boolean };

export function AdminLink({ url, external, download, children, ...props }: Props) {
  const { search } = useLocation();
  if (!external && !download && (!props.target || props.target === "_self") && /^\/app(?:\/|\?|$)/.test(url)) {
    const context = new URLSearchParams(getEmbeddedSearchEntries(search).map(({ name, value }) => [name, value]));
    return <Link {...props} to={withEmbeddedSearch(url, context.toString())}>{children}</Link>;
  }
  return <a {...props} href={url} download={download} target={props.target || (external ? "_blank" : undefined)} rel={props.rel || (external ? "noopener noreferrer" : undefined)}>{children}</a>;
}
