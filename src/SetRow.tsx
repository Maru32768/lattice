import type { ReactNode } from "react";

/** One settings row: title and description on the left, the control on the right. */
export function SetRow({ title, desc, htmlFor, children }: { title: ReactNode; desc?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="set">
      {htmlFor ? <label className="h" htmlFor={htmlFor}>{title}</label> : <div className="h">{title}</div>}
      {desc && <div className="d">{desc}</div>}
      {children && <div className="ctl">{children}</div>}
    </div>
  );
}

export function Switch({ id, checked, onChange }: { id: string; checked: boolean; onChange: (on: boolean) => void }) {
  return <input id={id} type="checkbox" role="switch" className="tg" checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}
