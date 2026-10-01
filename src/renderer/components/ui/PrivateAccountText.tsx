import { Fragment, useId, useState } from "react";
import "./private-account-text.css";

// Account labels can include a plan or display name alongside the address.
const EMAIL = /([\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+)/gu;

function PrivateEmail({ email }: { email: string }) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const [placeholder] = useState(() => `user-${Math.random().toString(36).slice(2, 10)}@example.com`);
  const action = revealed ? "Hide email address" : "Show email address";
  return (
    <button
      type="button"
      className="private-email"
      data-revealed={revealed}
      aria-label={action}
      aria-describedby={revealed ? id : undefined}
      aria-pressed={revealed}
      data-tooltip={action}
      onClick={() => setRevealed((value) => !value)}
    >
      <span id={id} aria-hidden={!revealed}>{revealed ? email : placeholder}</span>
    </button>
  );
}

/** Account emails enter the DOM only after the user reveals them. Other text stays readable. */
export function PrivateAccountText({ text }: { text: string }) {
  return <>{text.split(EMAIL).map((part, index) => index % 2
    ? <PrivateEmail key={`${index}:${part}`} email={part} />
    : <Fragment key={index}>{part}</Fragment>)}</>;
}
