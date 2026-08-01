import { createClient } from "@supabase/supabase-js";
const supabase = createClient("u", "k");

export const room = supabase.channel("ride-tracking");
export const notes = supabase.channel("driver-notes");
