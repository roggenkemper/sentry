import omit from 'lodash/omit';

import EventView from 'sentry/utils/discover/eventView';
import GenericDiscoverQuery, {
  DiscoverQueryProps,
  GenericChildrenProps,
} from 'sentry/utils/discover/genericDiscoverQuery';
import useApi from 'sentry/utils/useApi';

export interface MetricsCompatibilitySumData {
  sum: {
    metrics?: number;
    metrics_null?: number;
    metrics_unparam?: number;
  };
}

type QueryProps = Omit<DiscoverQueryProps, 'eventView' | 'api'> & {
  children: (props: GenericChildrenProps<MetricsCompatibilitySumData>) => React.ReactNode;
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

export default function MetricsCompatibilitySumsQuery({children, ...props}: QueryProps) {
  const api = useApi();
  return (
    <GenericDiscoverQuery<MetricsCompatibilitySumData, {}>
      route="metrics-compatibility"
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
