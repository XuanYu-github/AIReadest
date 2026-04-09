import React, { useCallback } from 'react';
import { RiRobot2Line } from 'react-icons/ri';
import Button from '@/components/Button';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useSettingsStore } from '@/store/settingsStore';
import { useAskAIStore } from '@/store/askAIStore';
import { useReaderStore } from '@/store/readerStore';
import { eventDispatcher } from '@/utils/event';

const AskAIToggler: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const iconSize16 = useResponsiveSize(16);
  const aiEnabled = useSettingsStore((state) => state.settings.aiSettings?.enabled ?? false);
  const toggleForBook = useAskAIStore((state) => state.toggleForBook);
  const openBookKey = useAskAIStore((state) => state.openBookKey);
  const setHoveredBookKey = useReaderStore((state) => state.setHoveredBookKey);
  const isOpen = openBookKey === bookKey;

  const handleOpenAskAI = useCallback(() => {
    if (!aiEnabled) {
      void eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('Enable Ask AI in Settings first.'),
        timeout: 2000,
      });
      return;
    }
    toggleForBook(bookKey);
    if (!isOpen) {
      void eventDispatcher.dispatch('ask-ai-open', { bookKey });
    }
    setHoveredBookKey('');
  }, [_, aiEnabled, bookKey, isOpen, setHoveredBookKey, toggleForBook]);

  return (
    <Button
      icon={<RiRobot2Line size={iconSize16} className={isOpen ? 'text-blue-500' : 'text-base-content'} />}
      onClick={handleOpenAskAI}
      label={_('Ask AI')}
      className={!aiEnabled ? 'opacity-70' : undefined}
    />
  );
};

export default AskAIToggler;
