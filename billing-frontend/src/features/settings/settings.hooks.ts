import { useQuery } from "@tanstack/react-query";

import * as settingsApi from "@/features/settings/settings.api";
import { queryKeys } from "@/lib/queryKeys";

export function useBusinessProfile() {
  return useQuery({
    queryKey: queryKeys.settings.businessProfile(),
    queryFn: settingsApi.getBusinessProfile,
    // gst_rate/gstin/state_code change essentially never — no need to
    // refetch this on every wizard mount.
    staleTime: 5 * 60 * 1000,
  });
}
