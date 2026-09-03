// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Accessible anchored tooltip primitives, skinned with Ink Carbon tokens. */
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { type ComponentProps, forwardRef, useId } from "react";
import "./components.css";

const IcTooltip = TooltipPrimitive.Root;
const IcTooltipTrigger = TooltipPrimitive.Trigger;

const IcTooltipContent = forwardRef<HTMLDivElement, ComponentProps<typeof TooltipPrimitive.Popup>>(
  ({ className, id, ...props }, ref) => {
    const generatedId = useId();
    return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side="bottom" sideOffset={6}>
        <TooltipPrimitive.Popup
          className={["pdpp-tooltip", className].filter(Boolean).join(" ")}
          ref={ref}
          id={id ?? generatedId}
          role="tooltip"
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
    );
  }
);
IcTooltipContent.displayName = "IcTooltipContent";

export { IcTooltip, IcTooltipContent, IcTooltipTrigger };
