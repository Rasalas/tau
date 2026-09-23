import type { ReactElement, SVGProps } from "react";
import type { RequestService } from "./protocol.js";

type IconProps = SVGProps<SVGSVGElement>;

/** Monochrome marks of the Git hosts, drawn in the text colour around them. */
const MARKS: Record<RequestService, (props: IconProps) => ReactElement> = {
  github: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z" />
    </svg>
  ),
  gitlab: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m12 21.6-9.2-6.7a.8.8 0 0 1-.3-.9L3.9 9.8 6.5 2.3a.4.4 0 0 1 .8 0L9.8 9.8h4.4l2.5-7.5a.4.4 0 0 1 .8 0l2.6 7.5 1.4 4.2a.8.8 0 0 1-.3.9Z" />
    </svg>
  ),
  forgejo: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" {...props}>
      <path d="M7 20V9.5A4.5 4.5 0 0 1 11.5 5H15" />
      <path d="M7 20v-3.5a4.5 4.5 0 0 1 4.5-4.5H15" />
      <circle cx="17.5" cy="5" r="2.3" />
      <circle cx="17.5" cy="12" r="2.3" />
      <circle cx="7" cy="20" r="2.3" />
    </svg>
  ),
  bitbucket: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <path d="M2.3 2.8a.7.7 0 0 0-.7.8l2.9 17.6c.1.5.5.8 1 .8h13.3c.3 0 .6-.3.7-.6l3-17.8a.7.7 0 0 0-.7-.8Zm12.2 12.8H9.6L8.3 8.4h7.5Z" />
    </svg>
  ),
  "azure-devops": (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M22 5.6v12.6l-5.2 4.3-8-2.9v2.9l-4.5-5.9 13.2 1V6.4ZM17.6 6.3 10.2 1.5v3L3.4 6.5 1.9 8.4v4.4l3 1.3V7.9Z" />
    </svg>
  ),
};

export function ServiceIcon({ service, ...props }: IconProps & { service: RequestService }) {
  const Mark = MARKS[service];
  return <Mark width={12} height={12} {...props} />;
}
