import { isHdrTransfer } from "./colorspace.js";

export function getSourceDisplayStatus(source, hdrAvailable) {
  if (!source?.displayTransfer) {
    return { label: "HDR ?", active: false, key: "DISPLAY_UNKNOWN" };
  }
  const hdrSource = isHdrTransfer(source.displayTransfer);
  const active = hdrSource && hdrAvailable;
  return {
    label: active ? "HDR" : "SDR",
    active,
    key: active ? "DISPLAY_HDR" : hdrSource ? "DISPLAY_SDR_SCREEN" : "DISPLAY_SDR_SOURCE"
  };
}

export function watchHdrDisplay(onChange, target = window) {
  const query = target.matchMedia("(dynamic-range: high)");
  const events = ["pageshow", "focus", "resize"];
  let previous;
  const update = () => {
    const available = query.matches;
    if (available === previous) return;
    previous = available;
    onChange(available);
  };

  query.addEventListener("change", update);
  for (const event of events) target.addEventListener(event, update);
  update();

  return () => {
    query.removeEventListener("change", update);
    for (const event of events) target.removeEventListener(event, update);
  };
}
