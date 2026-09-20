import React from "react";
import { sourceLabel, sourceShort } from "../utils";

export default function SourceTag({ source }) {
  if (!source || source === "none") return null;
  return (
    <span className="source-tag" title={sourceLabel(source)}>
      {sourceShort(source)}
    </span>
  );
}
