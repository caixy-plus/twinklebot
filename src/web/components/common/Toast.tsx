import { useStore } from "../../state/store.js";
import { StatusText } from "./Icon.js";

export function Toast() {
  const toast = useStore((s) => s.toast);
  return (
    <div id="ui-toast" className="ui-toast" role="status" aria-live="polite" hidden={!toast.open}>
      <StatusText text={toast.message} />
    </div>
  );
}
