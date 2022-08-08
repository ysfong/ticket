import Router from '@koa/router';
import _ from 'lodash';

import * as yup from '@/utils/yup';
import { auth, customerServiceOnly, parseRange } from '@/middleware';
import { TicketStats } from '@/model/TicketStats';
import { CategoryService } from '@/service/category';
import { TicketStatusStats } from '@/model/TicketStatusStats';
import { TicketStatusStatsResponse } from '@/response/ticket-stats';
import { ticketFiltersSchema } from './ticket';
import { ClickHouse, FunctionColumn, quoteValue } from '@/orm/clickhouse';

const router = new Router().use(auth, customerServiceOnly);

const BaseSchema = {
  from: yup.date().required(),
  to: yup.date().required(),
  category: yup.string().optional(),
  customerService: yup.string().optional(),
};

const statsSchema = yup.object().shape(BaseSchema);
router.get('/', async (ctx) => {
  const { category, customerService, ...rest } = statsSchema.validateSync(ctx.query);
  const categoryIds = await getCategoryIds(category);
  const data = await TicketStats.fetchTicketStats({
    ...rest,
    customerServiceId: customerService,
    categoryIds,
  });
  ctx.body = data || {};
});

const fieldStatsSchema = yup.object(BaseSchema).shape({
  fields: yup.string().required(),
});
router.get('/fields', async (ctx) => {
  const { category, customerService, fields, ...rest } = fieldStatsSchema.validateSync(ctx.query);
  const categoryIds = category === '*' ? '*' : await getCategoryIds(category);
  const data = await TicketStats.fetchTicketFieldStats({
    ...rest,
    customerServiceId: customerService,
    categoryIds,
    fields: fields.split(','),
  });
  ctx.body = data;
});

const statusSchema = yup.object(BaseSchema).pick(['from', 'to']);
router.get('/status', async (ctx) => {
  const { from, to } = statusSchema.validateSync(ctx.query);
  const data = await TicketStatusStats.fetchTicketStatus({
    from,
    to,
  });
  ctx.body = data.map((value) => new TicketStatusStatsResponse(value));
});

const detailSchema = yup.object(BaseSchema).shape({
  field: yup.string().required(),
});
router.get('/details', async (ctx) => {
  const { category, customerService, ...rest } = detailSchema.validateSync(ctx.query);
  const data = await TicketStats.fetchReplyDetails({
    ...rest,
    customerServiceId: customerService,
    categoryId: category,
  });
  ctx.body = data || [];
});

const activeTicketCountSchema = yup.object(BaseSchema).pick(['from', 'to']);
router.get('/count', async (ctx) => {
  const params = activeTicketCountSchema.validateSync(ctx.query);
  const data = await TicketStats.fetchReplyDetails({
    ...params,
    field: 'naturalReplyTime',
    customerServiceId: '*',
  });
  ctx.body = _(data).groupBy('nid').keys().valueOf().length;
});

const realtimeSchema = ticketFiltersSchema.omit(['page', 'pageSize', 'tagKey', 'tagValue']).shape({
  type: yup.string().oneOf(['status', 'category', 'group', 'assignee']).required(),
});
router.get('/realtime', parseRange('createdAt'), async (ctx) => {
  const params = realtimeSchema.validateSync(ctx.query);
  const categoryIds = await getCategoryIds(params.product || params.rootCategoryId);
  let selectList: string[] = [];
  let groupBy: string[] = [];
  switch (params.type) {
    case 'status':
      selectList = [
        'countIf(status = 280) as closed',
        'countIf(status = 250) as fulfilled',
        'countIf(status = 220) as preFulfilled',
        'countIf(status = 160) as waitingCustomer',
        'countIf(status = 120) as waitingCustomerService',
        'countIf(status = 50) as notProcessed',
      ];
      break;
    case 'category':
      selectList = ['categoryId', 'count() as count'];
      groupBy = ['categoryId'];
      break;
    case 'group':
      selectList = ['groupId', 'count() as count'];
      groupBy = ['groupId'];
      break;
    case 'assignee':
      selectList = ['assigneeId', 'count() as count'];
      groupBy = ['assigneeId'];
      break;
  }
  let privateTagCondition = [];
  if (params['privateTagKey']) {
    privateTagCondition.push(params['privateTagKey']);
  }
  if (params['privateTagValue']) {
    privateTagCondition.push(params['privateTagValue']);
  }

  const ticketLogLatest = new ClickHouse()
    .from('TicketLog')
    .select(
      'argMax(authorId, updatedAt) as authorId',
      'argMax(assigneeId, updatedAt) as assigneeId',
      'argMax(groupId, updatedAt) as groupId',
      'argMax(status, updatedAt) as status',
      'argMax(categoryId, updatedAt) as categoryId',
      'argMax(ticketCreatedAt, updatedAt) as ticketCreatedAt',
      'argMax(evaluation, updatedAt) as evaluation',
      'argMax(privateTags, updatedAt) as privateTags',
      'ticketId',
      'nid'
    )
    .groupBy('ticketId', 'nid');

  const data = await new ClickHouse()
    .from(ticketLogLatest)
    .select(...selectList)
    .where('authorId', params['authorId'])
    .where('assigneeId', params['assigneeId'], 'in')
    .where('groupId', params['groupId'], 'in')
    .where('status', params['status'], 'in')
    .where('categoryId', categoryIds, 'in')
    .where('ticketCreatedAt', params.createdAtFrom, '>')
    .where('ticketCreatedAt', params.createdAtTo, '<')
    .where(new FunctionColumn(`JSONExtractInt(evaluation,'star')`), params['evaluation.star'])
    .where(
      new FunctionColumn(
        `arrayExists( v ->${privateTagCondition
          .map((v, i) => `tupleElement(v, ${i + 1}) = ${quoteValue(v)}`)
          .join(' and ')},
            arrayMap( (v) -> (
                JSONExtractString(v, 'key'),
                JSONExtractString(v, 'value')
            ),privateTags))`
      ),
      privateTagCondition.length > 0 ? 1 : undefined
    )
    .groupBy(...groupBy)
    .find();
  ctx.body = data;
});

export default router;

async function getCategoryIds(categoryId?: string) {
  if (!categoryId) {
    return;
  }
  const categories = await CategoryService.getSubCategories(categoryId);
  return [categoryId, ...categories.map((v) => v.id)];
}
