import trimStart from 'lodash/trimStart';

import {doEventsRequest} from 'sentry/actionCreators/events';
import {Client} from 'sentry/api';
import {isMultiSeriesStats} from 'sentry/components/charts/utils';
import Link from 'sentry/components/links/link';
import Tooltip from 'sentry/components/tooltip';
import {t} from 'sentry/locale';
import {
  EventsStats,
  MultiSeriesEventsStats,
  Organization,
  PageFilters,
  SelectValue,
  TagCollection,
} from 'sentry/types';
import {Series} from 'sentry/types/echarts';
import {CustomMeasurementCollection} from 'sentry/utils/customMeasurements/customMeasurements';
import {EventsTableData, TableData} from 'sentry/utils/discover/discoverQuery';
import {MetaType} from 'sentry/utils/discover/eventView';
import {
  getFieldRenderer,
  RenderFunctionBaggage,
} from 'sentry/utils/discover/fieldRenderers';
import {
  AggregationOutputType,
  errorsAndTransactionsAggregateFunctionOutputType,
  getAggregateAlias,
  isEquation,
  isEquationAlias,
  isLegalYAxisType,
  QueryFieldValue,
  SPAN_OP_BREAKDOWN_FIELDS,
  stripEquationPrefix,
} from 'sentry/utils/discover/fields';
import {
  DiscoverQueryRequestParams,
  doDiscoverQuery,
} from 'sentry/utils/discover/genericDiscoverQuery';
import {Container} from 'sentry/utils/discover/styles';
import {TOP_N} from 'sentry/utils/discover/types';
import {
  eventDetailsRouteWithEventView,
  generateEventSlug,
} from 'sentry/utils/discover/urls';
import {getShortEventId} from 'sentry/utils/events';
import {getMeasurements} from 'sentry/utils/measurements/measurements';
import {FieldValueOption} from 'sentry/views/eventsV2/table/queryField';
import {FieldValue, FieldValueKind} from 'sentry/views/eventsV2/table/types';
import {generateFieldOptions} from 'sentry/views/eventsV2/utils';
import {getTraceDetailsUrl} from 'sentry/views/performance/traceDetails/utils';

import {DisplayType, Widget, WidgetQuery} from '../types';
import {
  eventViewFromWidget,
  getDashboardsMEPQueryParams,
  getNumEquations,
  getWidgetInterval,
} from '../utils';
import {EventsSearchBar} from '../widgetBuilder/buildSteps/filterResultsStep/eventsSearchBar';
import {CUSTOM_EQUATION_VALUE} from '../widgetBuilder/buildSteps/sortByStep';
import {
  flattenMultiSeriesDataWithGrouping,
  transformSeries,
} from '../widgetCard/widgetQueries';

import {DatasetConfig, handleOrderByReset} from './base';

const DEFAULT_WIDGET_QUERY: WidgetQuery = {
  name: '',
  fields: ['count()'],
  columns: [],
  fieldAliases: [],
  aggregates: ['count()'],
  conditions: '',
  orderby: '-count()',
};

type SeriesWithOrdering = [order: number, series: Series];

export const ErrorsAndTransactionsConfig: DatasetConfig<
  EventsStats | MultiSeriesEventsStats,
  TableData | EventsTableData
> = {
  defaultWidgetQuery: DEFAULT_WIDGET_QUERY,
  enableEquations: true,
  getCustomFieldRenderer: getCustomEventsFieldRenderer,
  SearchBar: EventsSearchBar,
  filterSeriesSortOptions,
  filterYAxisAggregateParams,
  filterYAxisOptions,
  getTableFieldOptions: getEventsTableFieldOptions,
  getTimeseriesSortOptions,
  getTableSortOptions,
  getGroupByFieldOptions: getEventsTableFieldOptions,
  handleOrderByReset,
  supportedDisplayTypes: [
    DisplayType.AREA,
    DisplayType.BAR,
    DisplayType.BIG_NUMBER,
    DisplayType.LINE,
    DisplayType.TABLE,
    DisplayType.TOP_N,
    DisplayType.WORLD_MAP,
  ],
  getTableRequest: (
    api: Client,
    query: WidgetQuery,
    organization: Organization,
    pageFilters: PageFilters,
    limit?: number,
    cursor?: string,
    referrer?: string
  ) => {
    const shouldUseEvents = organization.features.includes(
      'discover-frontend-use-events-endpoint'
    );
    const url = shouldUseEvents
      ? `/organizations/${organization.slug}/events/`
      : `/organizations/${organization.slug}/eventsv2/`;
    return getEventsRequest(
      url,
      api,
      query,
      organization,
      pageFilters,
      limit,
      cursor,
      referrer
    );
  },
  getSeriesRequest: getEventsSeriesRequest,
  getWorldMapRequest: (
    api: Client,
    query: WidgetQuery,
    organization: Organization,
    pageFilters: PageFilters,
    limit?: number,
    cursor?: string,
    referrer?: string
  ) => {
    return getEventsRequest(
      `/organizations/${organization.slug}/events-geo/`,
      api,
      query,
      organization,
      pageFilters,
      limit,
      cursor,
      referrer
    );
  },
  transformSeries: transformEventsResponseToSeries,
  transformTable: transformEventsResponseToTable,
  filterTableOptions,
  filterAggregateParams,
  getSeriesResultType,
};

function getTableSortOptions(_organization: Organization, widgetQuery: WidgetQuery) {
  const {columns, aggregates} = widgetQuery;
  const options: SelectValue<string>[] = [];
  let equations = 0;
  [...aggregates, ...columns]
    .filter(field => !!field)
    .forEach(field => {
      let alias;
      const label = stripEquationPrefix(field);
      // Equations are referenced via a standard alias following this pattern
      if (isEquation(field)) {
        alias = `equation[${equations}]`;
        equations += 1;
      }

      options.push({label, value: alias ?? field});
    });

  return options;
}

function filterSeriesSortOptions(columns: Set<string>) {
  return (option: FieldValueOption) => {
    if (
      option.value.kind === FieldValueKind.FUNCTION ||
      option.value.kind === FieldValueKind.EQUATION
    ) {
      return true;
    }

    return (
      columns.has(option.value.meta.name) ||
      option.value.meta.name === CUSTOM_EQUATION_VALUE
    );
  };
}

function getTimeseriesSortOptions(
  organization: Organization,
  widgetQuery: WidgetQuery,
  tags?: TagCollection
) {
  const options: Record<string, SelectValue<FieldValue>> = {};
  options[`field:${CUSTOM_EQUATION_VALUE}`] = {
    label: 'Custom Equation',
    value: {
      kind: FieldValueKind.EQUATION,
      meta: {name: CUSTOM_EQUATION_VALUE},
    },
  };

  let equations = 0;
  [...widgetQuery.aggregates, ...widgetQuery.columns]
    .filter(field => !!field)
    .forEach(field => {
      let alias;
      const label = stripEquationPrefix(field);
      // Equations are referenced via a standard alias following this pattern
      if (isEquation(field)) {
        alias = `equation[${equations}]`;
        equations += 1;
        options[`equation:${alias}`] = {
          label,
          value: {
            kind: FieldValueKind.EQUATION,
            meta: {
              name: alias ?? field,
            },
          },
        };
      }
    });

  const fieldOptions = getEventsTableFieldOptions(organization, tags);

  return {...options, ...fieldOptions};
}

function getEventsTableFieldOptions(
  organization: Organization,
  tags?: TagCollection,
  customMeasurements?: CustomMeasurementCollection
) {
  const measurements = getMeasurements();

  return generateFieldOptions({
    organization,
    tagKeys: Object.values(tags ?? {}).map(({key}) => key),
    measurementKeys: Object.values(measurements).map(({key}) => key),
    spanOperationBreakdownKeys: SPAN_OP_BREAKDOWN_FIELDS,
    customMeasurements:
      organization.features.includes('dashboards-mep') ||
      organization.features.includes('mep-rollout-flag')
        ? Object.values(customMeasurements ?? {}).map(({key, functions}) => ({
            key,
            functions,
          }))
        : undefined,
  });
}

function transformEventsResponseToTable(
  data: TableData | EventsTableData,
  _widgetQuery: WidgetQuery,
  organization: Organization
): TableData {
  let tableData = data;
  const shouldUseEvents = organization.features.includes(
    'discover-frontend-use-events-endpoint'
  );
  // events api uses a different response format so we need to construct tableData differently
  if (shouldUseEvents) {
    const {fields, ...otherMeta} = (data as EventsTableData).meta ?? {};
    tableData = {
      ...data,
      meta: {...fields, ...otherMeta},
    } as TableData;
  }
  return tableData as TableData;
}

function filterYAxisAggregateParams(
  fieldValue: QueryFieldValue,
  displayType: DisplayType
) {
  return (option: FieldValueOption) => {
    // Only validate function parameters for timeseries widgets and
    // world map widgets.
    if (displayType === DisplayType.BIG_NUMBER) {
      return true;
    }

    if (fieldValue.kind !== FieldValueKind.FUNCTION) {
      return true;
    }

    const functionName = fieldValue.function[0];
    const primaryOutput = errorsAndTransactionsAggregateFunctionOutputType(
      functionName as string,
      option.value.meta.name
    );
    if (primaryOutput) {
      return isLegalYAxisType(primaryOutput);
    }

    if (
      option.value.kind === FieldValueKind.FUNCTION ||
      option.value.kind === FieldValueKind.EQUATION
    ) {
      // Functions and equations are not legal options as an aggregate/function parameter.
      return false;
    }

    return isLegalYAxisType(option.value.meta.dataType);
  };
}

function filterYAxisOptions(displayType: DisplayType) {
  return (option: FieldValueOption) => {
    // Only validate function names for timeseries widgets and
    // world map widgets.
    if (
      !(displayType === DisplayType.BIG_NUMBER) &&
      option.value.kind === FieldValueKind.FUNCTION
    ) {
      const primaryOutput = errorsAndTransactionsAggregateFunctionOutputType(
        option.value.meta.name,
        undefined
      );
      if (primaryOutput) {
        // If a function returns a specific type, then validate it.
        return isLegalYAxisType(primaryOutput);
      }
    }

    return option.value.kind === FieldValueKind.FUNCTION;
  };
}

function transformEventsResponseToSeries(
  data: EventsStats | MultiSeriesEventsStats,
  widgetQuery: WidgetQuery,
  organization: Organization
): Series[] {
  let output: Series[] = [];
  const queryAlias = widgetQuery.name;

  const widgetBuilderNewDesign =
    organization.features.includes('new-widget-builder-experience-design') || false;

  if (isMultiSeriesStats(data)) {
    let seriesWithOrdering: SeriesWithOrdering[] = [];
    const isMultiSeriesDataWithGrouping =
      widgetQuery.aggregates.length > 1 && widgetQuery.columns.length;

    // Convert multi-series results into chartable series. Multi series results
    // are created when multiple yAxis are used. Convert the timeseries
    // data into a multi-series data set.  As the server will have
    // replied with a map like: {[titleString: string]: EventsStats}
    if (widgetBuilderNewDesign && isMultiSeriesDataWithGrouping) {
      seriesWithOrdering = flattenMultiSeriesDataWithGrouping(data, queryAlias);
    } else {
      seriesWithOrdering = Object.keys(data).map((seriesName: string) => {
        const prefixedName = queryAlias ? `${queryAlias} : ${seriesName}` : seriesName;
        const seriesData: EventsStats = data[seriesName];
        return [
          seriesData.order || 0,
          transformSeries(seriesData, prefixedName, seriesName),
        ];
      });
    }

    output = [
      ...seriesWithOrdering
        .sort((itemA, itemB) => itemA[0] - itemB[0])
        .map(item => item[1]),
    ];
  } else {
    const field = widgetQuery.aggregates[0];
    const prefixedName = queryAlias ? `${queryAlias} : ${field}` : field;
    const transformed = transformSeries(data, prefixedName, field);
    output.push(transformed);
  }

  return output;
}

// Get the series result type from the EventsStats meta
function getSeriesResultType(
  data: EventsStats | MultiSeriesEventsStats,
  widgetQuery: WidgetQuery
): Record<string, AggregationOutputType> {
  const field = widgetQuery.aggregates[0];
  const resultTypes = {};
  // Need to use getAggregateAlias since events-stats still uses aggregate alias format
  if (isMultiSeriesStats(data)) {
    Object.keys(data).forEach(
      key => (resultTypes[key] = data[key].meta?.fields[getAggregateAlias(key)])
    );
  } else {
    resultTypes[field] = data.meta?.fields[getAggregateAlias(field)];
  }
  return resultTypes;
}

function renderEventIdAsLinkable(data, {eventView, organization}: RenderFunctionBaggage) {
  const id: string | unknown = data?.id;
  if (!eventView || typeof id !== 'string') {
    return null;
  }

  const eventSlug = generateEventSlug(data);

  const target = eventDetailsRouteWithEventView({
    orgSlug: organization.slug,
    eventSlug,
    eventView,
  });

  return (
    <Tooltip title={t('View Event')}>
      <Link data-test-id="view-event" to={target}>
        <Container>{getShortEventId(id)}</Container>
      </Link>
    </Tooltip>
  );
}

function renderTraceAsLinkable(
  data,
  {eventView, organization, location}: RenderFunctionBaggage
) {
  const id: string | unknown = data?.trace;
  if (!eventView || typeof id !== 'string') {
    return null;
  }
  const dateSelection = eventView.normalizeDateSelection(location);
  const target = getTraceDetailsUrl(organization, String(data.trace), dateSelection, {});

  return (
    <Tooltip title={t('View Trace')}>
      <Link data-test-id="view-trace" to={target}>
        <Container>{getShortEventId(id)}</Container>
      </Link>
    </Tooltip>
  );
}

export function getCustomEventsFieldRenderer(
  field: string,
  meta: MetaType,
  organization?: Organization
) {
  const isAlias = !organization?.features.includes(
    'discover-frontend-use-events-endpoint'
  );

  if (field === 'id') {
    return renderEventIdAsLinkable;
  }

  if (field === 'trace') {
    return renderTraceAsLinkable;
  }

  return getFieldRenderer(field, meta, isAlias);
}

function getEventsRequest(
  url: string,
  api: Client,
  query: WidgetQuery,
  organization: Organization,
  pageFilters: PageFilters,
  limit?: number,
  cursor?: string,
  referrer?: string
) {
  const isMEPEnabled =
    organization.features.includes('dashboards-mep') ||
    organization.features.includes('mep-rollout-flag');

  const eventView = eventViewFromWidget('', query, pageFilters);

  const params: DiscoverQueryRequestParams = {
    per_page: limit,
    cursor,
    referrer,
    ...getDashboardsMEPQueryParams(isMEPEnabled),
  };

  if (query.orderby) {
    params.sort = typeof query.orderby === 'string' ? [query.orderby] : query.orderby;
  }

  // TODO: eventually need to replace this with just EventsTableData as we deprecate eventsv2
  return doDiscoverQuery<TableData | EventsTableData>(api, url, {
    ...eventView.generateQueryStringObject(),
    ...params,
  });
}

function getEventsSeriesRequest(
  api: Client,
  widget: Widget,
  queryIndex: number,
  organization: Organization,
  pageFilters: PageFilters,
  referrer?: string
) {
  const widgetQuery = widget.queries[queryIndex];
  const {displayType, limit} = widget;
  const {environments, projects} = pageFilters;
  const {start, end, period: statsPeriod} = pageFilters.datetime;
  const interval = getWidgetInterval(displayType, {start, end, period: statsPeriod});
  const isMEPEnabled = organization.features.includes('dashboards-mep');
  let requestData;
  if (displayType === DisplayType.TOP_N) {
    requestData = {
      organization,
      interval,
      start,
      end,
      project: projects,
      environment: environments,
      period: statsPeriod,
      query: widgetQuery.conditions,
      yAxis: widgetQuery.aggregates[widgetQuery.aggregates.length - 1],
      includePrevious: false,
      referrer,
      partial: true,
      field: [...widgetQuery.columns, ...widgetQuery.aggregates],
      queryExtras: getDashboardsMEPQueryParams(isMEPEnabled),
      includeAllArgs: true,
      topEvents: TOP_N,
    };
    if (widgetQuery.orderby) {
      requestData.orderby = widgetQuery.orderby;
    }
  } else {
    requestData = {
      organization,
      interval,
      start,
      end,
      project: projects,
      environment: environments,
      period: statsPeriod,
      query: widgetQuery.conditions,
      yAxis: widgetQuery.aggregates,
      orderby: widgetQuery.orderby,
      includePrevious: false,
      referrer,
      partial: true,
      queryExtras: getDashboardsMEPQueryParams(isMEPEnabled),
      includeAllArgs: true,
    };
    if (widgetQuery.columns?.length !== 0) {
      requestData.topEvents = limit ?? TOP_N;
      requestData.field = [...widgetQuery.columns, ...widgetQuery.aggregates];

      // Compare field and orderby as aliases to ensure requestData has
      // the orderby selected
      // If the orderby is an equation alias, do not inject it
      const orderby = trimStart(widgetQuery.orderby, '-');
      if (
        widgetQuery.orderby &&
        !isEquationAlias(orderby) &&
        !requestData.field.includes(orderby)
      ) {
        requestData.field.push(orderby);
      }

      // The "Other" series is only included when there is one
      // y-axis and one widgetQuery
      requestData.excludeOther =
        widgetQuery.aggregates.length !== 1 || widget.queries.length !== 1;

      if (isEquation(trimStart(widgetQuery.orderby, '-'))) {
        const nextEquationIndex = getNumEquations(widgetQuery.aggregates);
        const isDescending = widgetQuery.orderby.startsWith('-');
        const prefix = isDescending ? '-' : '';

        // Construct the alias form of the equation and inject it into the request
        requestData.orderby = `${prefix}equation[${nextEquationIndex}]`;
        requestData.field = [
          ...widgetQuery.columns,
          ...widgetQuery.aggregates,
          trimStart(widgetQuery.orderby, '-'),
        ];
      }
    }
  }

  return doEventsRequest<true>(api, requestData);
}

// Custom Measurements aren't selectable as columns/yaxis without using an aggregate
function filterTableOptions(option: FieldValueOption) {
  return option.value.kind !== FieldValueKind.CUSTOM_MEASUREMENT;
}

// Checks fieldValue to see what function is being used and only allow supported custom measurements
function filterAggregateParams(option: FieldValueOption, fieldValue?: QueryFieldValue) {
  if (
    option.value.kind === FieldValueKind.CUSTOM_MEASUREMENT &&
    fieldValue?.kind === 'function' &&
    fieldValue?.function &&
    !option.value.meta.functions.includes(fieldValue.function[0])
  ) {
    return false;
  }
  return true;
}
