import type { SVGProps } from "react";
import { GIT_HOST_MARKS } from "../_git-hosts/marks.js";
import type { RequestService } from "./protocol.js";

type IconProps = SVGProps<SVGSVGElement>;

export function ServiceIcon({ service, ...props }: IconProps & { service: RequestService }) {
  const Mark = GIT_HOST_MARKS[service];
  return <Mark width={12} height={12} {...props} />;
}
