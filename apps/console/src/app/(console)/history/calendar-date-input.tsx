// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client";
import {useState,type ComponentProps} from "react";
import {IcInput,Text} from "@pdpp/brand-react";
import {personDate} from "./day-cut.ts";
const CALENDAR_DATE=/^\d{4}-\d{2}-\d{2}$/;
type Props=Omit<ComponentProps<typeof IcInput>,"type"|"value"|"defaultValue"> & {value?:string;defaultValue?:string};
/** Keep the native date value and picker; use the shared date form while resting. */
export function CalendarDateInput({value,defaultValue,onChange,...props}:Props) {
  const [chosen,setChosen]=useState(defaultValue ?? "");
  const iso=value ?? chosen;
  const valid=CALENDAR_DATE.test(iso) && Number.isFinite(Date.parse(`${iso}T12:00:00Z`));
  const display=valid ? personDate(`${iso}T12:00:00Z`,0) : "Choose a date";
  return <span className="group relative inline-flex min-w-0">
    <IcInput {...props} value={value} defaultValue={defaultValue} type="date" onChange={event=>{setChosen(event.currentTarget.value);onChange?.(event);}} />
    <Text as="span" aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-9 left-3 flex items-center bg-background text-[13px] group-focus-within:invisible ${valid ? "text-foreground" : "text-muted-foreground"}`}>{display}</Text>
  </span>;
}
