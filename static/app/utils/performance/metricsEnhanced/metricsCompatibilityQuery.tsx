import omit from 'lodash/omit';

import EventView from 'sentry/utils/discover/eventView';
import GenericDiscoverQuery, {
  DiscoverQueryProps,
  GenericChildrenProps,
} from 'sentry/utils/discover/genericDiscoverQuery';
import useApi from 'sentry/utils/useApi';

export interface MetricsCompatibilityData {
  compatible_projects?: number[];
  dynamic_sampling_projects?: number[];
}

type QueryProps = Omit<DiscoverQueryProps, 'eventView' | 'api'> & {
  children: (props: GenericChildrenProps<MetricsCompatibilityData>) => React.ReactNode;
  eventView: EventView;
};

function getRequestPayload({
  eventView,
  location,
}: Pick<DiscoverQueryProps, 'eventView' | 'location'>) {
  return omit(eventView.getEventsAPIPayload(location), [
    'field',
    'sort',
    'per_page',
    'query',
  ]);
}

export default function MetricsCompatibilityQuery({children, ...props}: QueryProps) {
  const api = useApi();
  return (
    <GenericDiscoverQuery<MetricsCompatibilityData, {}>
      route="metrics-compatibility-sums"
      getRequestPayload={getRequestPayload}
      {...props}
      api={api}
    >
      {({tableData, ...rest}) => {
        return children({
          tableData,
          ...rest,
        });
      }}
    </GenericDiscoverQuery>
  );
}
