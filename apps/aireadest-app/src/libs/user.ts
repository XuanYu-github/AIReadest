const AUTH_DISABLED_ERROR = 'Cloud account features are disabled in AIReadest';

export const deleteUser = async () => {
  throw new Error(AUTH_DISABLED_ERROR);
};
