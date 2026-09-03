// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Non-modal anchored popover primitives, skinned with Ink Carbon tokens. */
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { type ComponentProps, forwardRef } from "react";
import "./components.css";

const IcPopover = PopoverPrimitive.Root;
const IcPopoverClose = PopoverPrimitive.Close;
const IcPopoverTrigger = PopoverPrimitive.Trigger;

const IcPopoverPopup = forwardRef<HTMLDivElement, ComponentProps<typeof PopoverPrimitive.Popup>>(
  ({ className, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side="bottom" sideOffset={6}>
        <PopoverPrimitive.Popup
          className={["pdpp-popover", className].filter(Boolean).join(" ")}
          ref={ref}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
);
IcPopoverPopup.displayName = "IcPopoverPopup";

export { IcPopover, IcPopoverClose, IcPopoverPopup, IcPopoverTrigger };
