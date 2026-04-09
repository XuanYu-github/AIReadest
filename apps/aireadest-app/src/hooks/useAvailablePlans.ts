import { useEffect, useState } from 'react';
import { AvailablePlan } from '@/types/quota';
import { stubTranslation as _ } from '@/utils/misc';

interface UseAvailablePlansParams {
  hasIAP: boolean;
  onError?: (message: string) => void;
}

export const useAvailablePlans = ({ hasIAP, onError }: UseAvailablePlansParams) => {
  const disabledError = new Error('Subscription and payment flows are disabled in AIReadest.');
  const [availablePlans] = useState<AvailablePlan[]>([]);
  const [iapAvailable] = useState(false);
  const [loading] = useState(false);
  const [error] = useState<Error | null>(disabledError);

  useEffect(() => {
    if (onError) {
      onError(_('Failed to load subscription plans.'));
    }
  }, [hasIAP, onError]);

  return { availablePlans, iapAvailable, loading, error };
};
